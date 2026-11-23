import {
  addDeviceMessage,
  authMessage,
  bodyAad,
  decodeFrame,
  decodeMacMessage,
  deviceId,
  encodeAppMessage,
  encodeFrame,
  fromB64url,
  fromUtf8,
  generateEd25519,
  generateX25519,
  leaveDeviceMessage,
  pairCode,
  pairTokenHash,
  parseClientHeader,
  PartAssembler,
  phoneSessionKeys,
  removeDeviceMessage,
  SessionCipher,
  sign,
  toB64url,
  utf8,
  uuidv7,
  verifyB64,
  type ClientHeader,
  type MacMessage,
  type PhoneMessage,
  type RelayHeader
} from "@arden-hq/relay-protocol"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import type { SseFrame } from "@arden-hq/protocol"
import type { PairedDevice } from "../src/persistence/relay/store.js"
import { RelayConnector } from "../src/relay/connector.js"
import { loadMacIdentity } from "../src/relay/identity.js"
import type { CommandLog, DeviceRegistry, Loopback } from "../src/relay/ports.js"
import { memoryVault } from "./fixtures/memory-vault.js"

const waitFor = async <T>(read: () => T | undefined, what: string): Promise<T> => {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

type FromMac<T extends ClientHeader["t"]> = Extract<ClientHeader, { t: T }>

const fakeRelay = async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const received: Array<{ header: ClientHeader; body: Uint8Array }> = []
  const nonce = new Uint8Array(32).fill(7)
  let mac: WebSocket | undefined
  server.on("connection", (socket) => {
    mac = socket
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return
      const frame = decodeFrame(new Uint8Array(data))
      const header = frame.ok ? parseClientHeader(frame.header) : undefined
      if (!frame.ok || header === undefined) return
      received.push({ header, body: frame.body })
    })
    socket.send(encodeFrame({ t: "challenge", nonce: toB64url(nonce), now: Date.now() }))
  })
  const address = server.address()
  if (typeof address === "string" || address === null) throw new Error("no port")
  return {
    url: `ws://127.0.0.1:${address.port}`,
    nonce,
    deliver: (header: RelayHeader, body?: Uint8Array) => mac?.send(encodeFrame(header, body)),
    take: <T extends ClientHeader["t"]>(
      t: T,
      match: (header: FromMac<T>) => boolean = () => true
    ) =>
      waitFor(() => {
        const index = received.findIndex(
          (item) => item.header.t === t && match(item.header as FromMac<T>)
        )
        const item = received[index]
        if (item === undefined) return undefined
        received.splice(index, 1)
        return { header: item.header as FromMac<T>, body: item.body }
      }, `frame ${t}`),
    close: async () => {
      for (const client of server.clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const memoryDevices = (seed: ReadonlyArray<PairedDevice> = []) => {
  const rows = new Map<string, PairedDevice>(seed.map((device) => [device.dev, device]))
  const registry: DeviceRegistry = {
    list: async () => [...rows.values()],
    add: async (device) => {
      const row = {
        ...device,
        addedAt: "",
        lastSeenAt: undefined,
        push: undefined
      }
      rows.set(device.dev, row)
      return row
    },
    revoke: async (dev) => rows.delete(dev),
    seen: async () => {},
    setPush: async () => {}
  }
  return { rows, registry }
}

const unusedCommands: CommandLog = {
  find: async () => undefined,
  begin: async () => undefined,
  finish: async () => {}
}

const fakeServer = () => {
  const requests: Array<{ method: string; path: string }> = []
  const bus: Array<Pick<SseFrame, "id" | "data">> = []
  const loopback: Loopback = {
    request: async ({ method, path }) => {
      requests.push({ method, path })
      return { status: 200, body: { asks: [], letter: null } }
    },
    events: async function* ({ path, signal }) {
      if (path !== "/automations/events") return
      let next = 0
      while (!signal.aborted) {
        const frame = bus[next]
        if (frame === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          continue
        }
        next += 1
        yield frame
      }
    }
  }
  return {
    loopback,
    requests,
    publish: (frame: Pick<SseFrame, "id" | "data">) => bus.push(frame)
  }
}

const newPhone = () => {
  const ed = generateEd25519()
  const x = generateX25519()
  return { ed, x, dev: deviceId(ed.publicKey) }
}

const pairedRow = (phone: ReturnType<typeof newPhone>): PairedDevice => ({
  dev: phone.dev,
  name: "Test iPhone",
  edPub: toB64url(phone.ed.publicKey),
  xPub: toB64url(phone.x.publicKey),
  addedAt: "",
  lastSeenAt: undefined,
  push: undefined
})

describe("relay connector", () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  const boot = async (seed: ReadonlyArray<PairedDevice> = []) => {
    const relay = await fakeRelay()
    const identity = await loadMacIdentity(memoryVault())
    const devices = memoryDevices(seed)
    const server = fakeServer()
    const connector = new RelayConnector({
      identity,
      relayUrl: relay.url,
      phoneRelayUrl: relay.url,
      macName: "Test Mac",
      devices: devices.registry,
      commands: unusedCommands,
      loopback: server.loopback,
      log: () => {},
      setKeepAwake: async () => {}
    })
    cleanups.push(async () => {
      connector.stop()
      await relay.close()
    })
    await connector.start()
    const auth = await relay.take("auth")
    relay.deliver({ t: "ready", peers: [] })
    await waitFor(() => (connector.state === "connected" ? true : undefined), "connected")
    return { relay, identity, devices, server, connector, auth }
  }

  it("authenticates, offers a pairing link and adds the approved phone", async () => {
    const { relay, identity, devices, connector, auth } = await boot()
    expect(
      verifyB64({
        sig: auth.header.sig,
        message: authMessage({
          mac: identity.macId,
          dev: identity.macId,
          nonce: relay.nonce
        }),
        publicKey: toB64url(identity.ed.publicKey)
      })
    ).toBe(true)

    const offering = connector.offer()
    const offered = await relay.take("pair_offer")
    relay.deliver({ t: "pair_offered", token_hash: offered.header.token_hash })
    const link = new URL((await offering).link)
    const token = fromB64url(link.searchParams.get("t") ?? "")
    expect(pairTokenHash(token)).toBe(offered.header.token_hash)
    expect(link.searchParams.get("mac")).toBe(identity.macId)
    expect(link.searchParams.get("ek")).toBe(toB64url(identity.x.publicKey))

    const phone = newPhone()
    relay.deliver({
      t: "pair_request",
      dev: phone.dev,
      ed_pub: toB64url(phone.ed.publicKey),
      x_pub: toB64url(phone.x.publicKey),
      name: "Test iPhone"
    })
    const request = await waitFor(() => connector.pairRequest, "pair request")
    expect(request.code).toBe(
      pairCode({
        token,
        phoneEdPublicKey: phone.ed.publicKey,
        phoneXPublicKey: phone.x.publicKey
      })
    )

    expect(await connector.decide(phone.dev, true)).toBe(true)
    const added = await relay.take("add_device")
    expect(added.header.dev).toBe(phone.dev)
    expect(
      verifyB64({
        sig: added.header.sig_mac,
        message: addDeviceMessage({
          dev: phone.dev,
          edPublicKey: phone.ed.publicKey
        }),
        publicKey: toB64url(identity.ed.publicKey)
      })
    ).toBe(true)
    expect([...devices.rows.keys()]).toEqual([phone.dev])
  })

  it("answers a paired phone's read and streams events over the sealed session", async () => {
    const phone = newPhone()
    const { relay, identity, server } = await boot([pairedRow(phone)])
    const macId = identity.macId

    const ephemeral = generateX25519()
    relay.deliver(
      { t: "msg", from: phone.dev, id: uuidv7() },
      utf8(JSON.stringify({ t: "hs1", e: toB64url(ephemeral.publicKey) }))
    )
    const hs2 = await relay.take("msg", (header) => header.to === phone.dev)
    const reply: unknown = JSON.parse(fromUtf8(hs2.body))
    const macEphemeral =
      typeof reply === "object" && reply !== null && "e" in reply && typeof reply.e === "string"
        ? reply.e
        : ""
    const cipher = SessionCipher.forPhone(
      phoneSessionKeys({
        phoneStatic: phone.x,
        phoneEphemeral: ephemeral,
        macStaticPublic: identity.x.publicKey,
        macEphemeralPublic: fromB64url(macEphemeral)
      })
    )
    const assembler = new PartAssembler()
    const say = (message: PhoneMessage) => {
      for (const plaintext of encodeAppMessage(message))
        relay.deliver(
          { t: "msg", from: phone.dev, id: uuidv7() },
          cipher.seal(plaintext, bodyAad({ sender: phone.dev, receiver: macId }))
        )
    }
    const heard = async <T extends MacMessage["t"]>(
      t: T,
      match: (message: Extract<MacMessage, { t: T }>) => boolean
    ): Promise<Extract<MacMessage, { t: T }>> => {
      for (;;) {
        const frame = await relay.take("msg", (header) => header.to === phone.dev)
        const message = decodeMacMessage(
          assembler.receive(
            cipher.open(frame.body, bodyAad({ sender: macId, receiver: phone.dev }))
          )
        )
        if (message?.t === t && match(message as Extract<MacMessage, { t: T }>))
          return message as Extract<MacMessage, { t: T }>
      }
    }

    say({ t: "req", rid: "r1", method: "GET", path: "/mobile/home" })
    expect(await heard("res", (message) => message.rid === "r1")).toEqual({
      t: "res",
      rid: "r1",
      status: 200,
      body: { asks: [], letter: null }
    })
    say({ t: "req", rid: "r2", method: "GET", path: "/mobile/../config" })
    expect(await heard("res", (message) => message.rid === "r2")).toMatchObject({ status: 403 })
    expect(server.requests).toEqual([{ method: "GET", path: "/mobile/home" }])

    say({ t: "sub", sid: "bus", path: "/automations/events" })
    server.publish({
      id: "41",
      data: JSON.stringify({ type: "session_activity", seq: 41 })
    })
    server.publish({
      id: "45",
      data: JSON.stringify({ type: "work_changed", seq: 45 })
    })
    expect(await heard("ev", (message) => message.seq === 1)).toMatchObject({
      sid: "bus",
      data: { type: "session_activity", seq: 41 }
    })
    expect(await heard("ev", (message) => message.seq === 2)).toMatchObject({
      data: { type: "work_changed", seq: 45 }
    })
  })

  it("forgets a revoked phone, and honors a phone's leave only when it signed it", async () => {
    const stays = newPhone()
    const leaves = newPhone()
    const removed = newPhone()
    const { relay, identity, devices, connector } = await boot([
      pairedRow(stays),
      pairedRow(leaves),
      pairedRow(removed)
    ])

    await connector.remove(removed.dev)
    const removal = await relay.take("remove_device")
    expect(removal.header.dev).toBe(removed.dev)
    expect(
      verifyB64({
        sig: removal.header.sig_mac,
        message: removeDeviceMessage({ dev: removed.dev }),
        publicKey: toB64url(identity.ed.publicKey)
      })
    ).toBe(true)
    expect(devices.rows.has(removed.dev)).toBe(false)

    const forged = sign(
      leaveDeviceMessage({ mac: identity.macId, dev: stays.dev }),
      leaves.ed.secretKey
    )
    relay.deliver({ t: "device_left", dev: stays.dev, sig: toB64url(forged) })
    const genuine = sign(
      leaveDeviceMessage({ mac: identity.macId, dev: leaves.dev }),
      leaves.ed.secretKey
    )
    relay.deliver({
      t: "device_left",
      dev: leaves.dev,
      sig: toB64url(genuine)
    })
    expect((await relay.take("remove_device")).header.dev).toBe(leaves.dev)
    expect([...devices.rows.keys()]).toEqual([stays.dev])
  })
})
