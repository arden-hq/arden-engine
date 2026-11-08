import {
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
  pairCode,
  parseRelayHeader,
  PartAssembler,
  phoneSessionKeys,
  SessionCipher,
  sign,
  toB64url,
  utf8,
  uuidv7,
  type ClientHeader,
  type MacMessage,
  type PhoneMessage,
  type RelayHeader
} from "@arden-hq/relay-protocol"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import type { PairedDevice, RelayCommandRecord } from "../src/persistence/relay/store.js"
import { RelayConnector } from "../src/relay/connector.js"
import { loadMacIdentity } from "../src/relay/identity.js"
import { memoryVault } from "./fixtures/memory-vault.js"
import type { CommandLog, DeviceRegistry, Loopback } from "../src/relay/ports.js"
import type { SseFrame } from "@arden-hq/protocol"

const waitFor = async <T>(read: () => T | undefined, what: string, ms = 5_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const startRelay = async (): Promise<{ url: string; process: ChildProcess }> => {
  const cwd = fileURLToPath(new URL("../../relay", import.meta.url))
  const child = spawn(
    "bun",
    ["--conditions=arden-source", "src/bun/main.ts", "--port", "0", "--db", ":memory:"],
    { cwd, stdio: ["ignore", "pipe", "inherit"] }
  )
  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  const url = await waitFor(
    () => /listening on (ws:\/\/[^/\s]+)\/v1\/connect/.exec(output)?.[1],
    "the relay to listen",
    20_000
  )
  return { url, process: child }
}

const fakeServer = () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  const bus: Array<Pick<SseFrame, "id" | "data">> = []
  let wake: (() => void) | undefined
  const loopback: Loopback = {
    request: async ({ method, path, body }) => {
      requests.push({ method, path, body })
      if (method === "GET" && path === "/mobile/home")
        return { status: 200, body: { asks: [], letter: null } }
      if (method === "POST" && path === "/chat/message")
        return { status: 200, body: { status: "accepted" } }
      if (method === "POST" && path === "/cancel")
        return { status: 202, body: { status: "cancelling" } }
      return { status: 404, body: null }
    },
    events: async function* ({ path, signal }) {
      if (path !== "/automations/events") return
      let next = 0
      while (!signal.aborted) {
        const frame = bus[next]
        if (frame !== undefined) {
          next += 1
          yield frame
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    }
  }
  return {
    loopback,
    requests,
    publish: (frame: Pick<SseFrame, "id" | "data">) => {
      bus.push(frame)
      wake?.()
    }
  }
}

const memoryDevices = (): DeviceRegistry & { readonly rows: Map<string, PairedDevice> } => {
  const rows = new Map<string, PairedDevice>()
  return {
    rows,
    list: async () => [...rows.values()],
    add: async (device) => {
      const row = {
        ...device,
        addedAt: new Date().toISOString(),
        lastSeenAt: undefined,
        push: undefined
      }
      rows.set(device.dev, row)
      return row
    },
    revoke: async (dev) => rows.delete(dev),
    seen: async () => {},
    setPush: async (dev, push) => {
      const row = rows.get(dev)
      if (row !== undefined) rows.set(dev, { ...row, push })
    }
  }
}

const memoryCommands = (): CommandLog => {
  const rows = new Map<string, RelayCommandRecord>()
  return {
    find: async (cid) => rows.get(cid),
    begin: async ({ cid, kind }) => {
      const known = rows.get(cid)
      if (known !== undefined) return known
      rows.set(cid, { cid, kind, state: "running", result: undefined, createdAt: "" })
      return undefined
    },
    finish: async ({ cid, state, result }) => {
      const known = rows.get(cid)
      if (known !== undefined) rows.set(cid, { ...known, state, result })
    }
  }
}

const isType = <U extends { readonly t: string }, T extends U["t"]>(
  value: U,
  t: T
): value is Extract<U, { t: T }> => value.t === t

const connectPhone = async (relayUrl: string, macId: string) => {
  const ed = generateEd25519()
  const x = generateX25519()
  const dev = deviceId(ed.publicKey)
  const socket = new WebSocket(`${relayUrl}/v1/connect?mac=${macId}`)
  const frames: Array<{ header: RelayHeader; body: Uint8Array }> = []
  const app: MacMessage[] = []
  let cipher: SessionCipher | undefined
  let handshake: { secretKey: Uint8Array; publicKey: Uint8Array } | undefined
  const assembler = new PartAssembler()
  let closedCode: number | undefined
  socket.on("close", (code) => {
    closedCode = code
  })
  socket.on("message", (data: Buffer, isBinary) => {
    if (!isBinary) return
    const frame = decodeFrame(new Uint8Array(data))
    const header = frame.ok ? parseRelayHeader(frame.header) : undefined
    if (!frame.ok || header === undefined) throw new Error("unreadable relay frame")
    if (header.t === "msg" && header.from === macId) {
      if (frame.body[0] === 0x7b) {
        const hs2: unknown = JSON.parse(fromUtf8(frame.body))
        if (handshake === undefined || typeof hs2 !== "object" || hs2 === null) return
        const e = "e" in hs2 && typeof hs2.e === "string" ? hs2.e : ""
        cipher = SessionCipher.forPhone(
          phoneSessionKeys({
            phoneStatic: x,
            phoneEphemeral: handshake,
            macStaticPublic: macX,
            macEphemeralPublic: fromB64url(e)
          })
        )
        return
      }
      const value = assembler.receive(
        cipher?.open(frame.body, bodyAad({ sender: macId, receiver: dev })) ?? new Uint8Array()
      )
      const message = decodeMacMessage(value)
      if (message !== undefined) app.push(message)
      return
    }
    frames.push({ header, body: frame.body })
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
  let macX: Uint8Array = new Uint8Array()
  const send = (header: ClientHeader, body?: Uint8Array) => socket.send(encodeFrame(header, body))
  const take = <T extends RelayHeader["t"]>(t: T) =>
    waitFor(() => {
      const index = frames.findIndex((frame) => frame.header.t === t)
      const header = frames[index]?.header
      if (header === undefined || !isType(header, t)) return undefined
      frames.splice(index, 1)
      return header
    }, `relay frame ${t}`)
  return {
    dev,
    ed,
    x,
    take,
    get closedCode() {
      return closedCode
    },
    pair: async (link: URL) => {
      macX = fromB64url(link.searchParams.get("ek") ?? "")
      const challenge = await take("challenge")
      const sig = sign(
        authMessage({ mac: macId, dev, nonce: fromB64url(challenge.nonce) }),
        ed.secretKey
      )
      send({
        t: "auth",
        mac: macId,
        dev,
        role: "phone",
        sig: toB64url(sig),
        ed_pub: toB64url(ed.publicKey),
        x_pub: toB64url(x.publicKey),
        name: "Test iPhone",
        pair_token: link.searchParams.get("t") ?? ""
      })
      await take("pair_pending")
    },
    handshake: async () => {
      handshake = generateX25519()
      send(
        { t: "msg", to: macId, id: uuidv7() },
        utf8(JSON.stringify({ t: "hs1", e: toB64url(handshake.publicKey) }))
      )
      await waitFor(() => cipher, "hs2")
    },
    send: (message: PhoneMessage) => {
      if (cipher === undefined) throw new Error("no session")
      for (const plaintext of encodeAppMessage(message)) {
        send(
          { t: "msg", to: macId, id: uuidv7() },
          cipher.seal(plaintext, bodyAad({ sender: dev, receiver: macId }))
        )
      }
    },
    next: <T extends MacMessage["t"]>(t: T, match: (m: Extract<MacMessage, { t: T }>) => boolean) =>
      waitFor(() => {
        const index = app.findIndex((message) => isType(message, t) && match(message))
        const message = app[index]
        if (message === undefined || !isType(message, t)) return undefined
        app.splice(index, 1)
        return message
      }, `app message ${t}`),
    close: () => socket.close()
  }
}

describe("relay connector end to end", () => {
  let relay: { url: string; process: ChildProcess }
  beforeAll(async () => {
    relay = await startRelay()
  })
  afterAll(() => {
    relay.process.kill()
  })

  it("pairs a phone, serves its reads, streams, commands and revoke", async () => {
    const identity = await loadMacIdentity(memoryVault())
    const server = fakeServer()
    const devices = memoryDevices()
    const connector = new RelayConnector({
      identity,
      relayUrl: relay.url,
      phoneRelayUrl: relay.url,
      macName: "Test Mac",
      devices,
      commands: memoryCommands(),
      loopback: server.loopback,
      log: () => {},
      setKeepAwake: async () => {}
    })
    await connector.start()
    await waitFor(() => (connector.state === "connected" ? true : undefined), "the Mac to connect")

    const refused = await connectPhone(relay.url, identity.macId)
    await refused.pair(new URL((await connector.offer()).link))
    await waitFor(() => connector.pairRequest, "the refused pair request")
    expect(await connector.decide(refused.dev, false)).toBe(true)
    expect(await refused.take("error")).toEqual({
      t: "error",
      code: "forbidden",
      message: "Your Mac said no."
    })
    expect(await waitFor(() => refused.closedCode, "the refused phone to close")).toBe(4005)
    expect(devices.rows.size).toBe(0)

    const shown = await connector.offer()
    expect((await connector.offer()).link).toBe(shown.link)
    const quitter = await connectPhone(relay.url, identity.macId)
    await quitter.pair(new URL(shown.link))
    await waitFor(() => connector.pairRequest, "the quitter's pair request")
    quitter.close()
    await waitFor(
      () => (connector.pairRequest === undefined ? true : undefined),
      "the request to clear"
    )

    const offer = await connector.offer()
    const link = new URL(offer.link)
    expect(link.protocol).toBe("arden:")
    expect(Object.fromEntries(link.searchParams)).toMatchObject({
      v: "1",
      relay: relay.url,
      mac: identity.macId,
      name: "Test Mac",
      ek: toB64url(identity.x.publicKey),
      sk: toB64url(identity.ed.publicKey)
    })
    const phone = await connectPhone(relay.url, identity.macId)
    await phone.pair(link)
    const request = await waitFor(() => connector.pairRequest, "the pair request")
    const phoneCode = pairCode({
      token: fromB64url(link.searchParams.get("t") ?? ""),
      phoneEdPublicKey: phone.ed.publicKey,
      phoneXPublicKey: phone.x.publicKey
    })
    expect(request).toEqual({
      dev: phone.dev,
      name: "Test iPhone",
      edPub: toB64url(phone.ed.publicKey),
      xPub: toB64url(phone.x.publicKey),
      code: phoneCode
    })
    expect(await connector.decide(phone.dev, true)).toBe(true)
    await phone.take("ready")
    expect([...devices.rows.keys()]).toEqual([phone.dev])

    await phone.handshake()
    phone.send({ t: "resume", streams: {}, pending: [] })
    phone.send({ t: "req", rid: "r1", method: "GET", path: "/mobile/home" })
    expect(await phone.next("res", (m) => m.rid === "r1")).toEqual({
      t: "res",
      rid: "r1",
      status: 200,
      body: { asks: [], letter: null }
    })
    phone.send({ t: "req", rid: "r2", method: "GET", path: "/mobile/../config" })
    phone.send({ t: "req", rid: "r3", method: "POST", path: "/chat/message", body: {} })
    expect(await phone.next("res", (m) => m.rid === "r2")).toEqual({
      t: "res",
      rid: "r2",
      status: 403,
      body: { message: "Your Mac couldn't do that." }
    })
    expect(await phone.next("res", (m) => m.rid === "r3")).toMatchObject({ status: 403 })

    phone.send({ t: "sub", sid: "bus", path: "/automations/events" })
    server.publish({ id: "41", data: JSON.stringify({ type: "session_activity", seq: 41 }) })
    server.publish({ id: "45", data: JSON.stringify({ type: "work_changed", seq: 45 }) })
    expect(await phone.next("ev", (m) => m.seq === 1)).toEqual({
      t: "ev",
      sid: "bus",
      seq: 1,
      data: { type: "session_activity", seq: 41 }
    })
    expect(await phone.next("ev", (m) => m.seq === 2)).toMatchObject({
      data: { type: "work_changed", seq: 45 }
    })

    const cid = uuidv7()
    const send: PhoneMessage = {
      t: "cmd",
      cid,
      ts: Date.now(),
      kind: "send",
      args: { session_id: "chat-1", text: "From the phone" }
    }
    phone.send(send)
    expect(await phone.next("cmd_ack", (m) => m.cid === cid)).toEqual({
      t: "cmd_ack",
      cid,
      state: "done",
      result: { status: "accepted" }
    })
    phone.send(send)
    expect(await phone.next("cmd_ack", (m) => m.cid === cid)).toMatchObject({ state: "done" })
    expect(server.requests.filter((r) => r.path === "/chat/message")).toEqual([
      {
        method: "POST",
        path: "/chat/message",
        body: { session_id: "chat-1", message: "From the phone", client_id: cid }
      }
    ])

    const stop = uuidv7()
    phone.send({
      t: "cmd",
      cid: stop,
      ts: Date.now(),
      kind: "stop",
      args: { session_id: "chat-1" }
    })
    expect(await phone.next("cmd_ack", (m) => m.cid === stop)).toMatchObject({ state: "stopping" })

    const late = uuidv7()
    phone.send({
      t: "cmd",
      cid: late,
      ts: Date.now() - 25 * 60 * 60_000,
      kind: "send",
      args: { session_id: "chat-1", text: "Too late" }
    })
    expect(await phone.next("cmd_ack", (m) => m.cid === late)).toMatchObject({
      state: "rejected"
    })

    const token = "ab".repeat(32)
    const register = uuidv7()
    phone.send({
      t: "cmd",
      cid: register,
      ts: Date.now(),
      kind: "register_push",
      args: { token: token.toUpperCase(), environment: "sandbox", topic: "com.arden.ios" }
    })
    expect(await phone.next("cmd_ack", (m) => m.cid === register)).toEqual({
      t: "cmd_ack",
      cid: register,
      state: "done",
      result: null
    })
    const pushTarget = { token, env: "sandbox", topic: "com.arden.ios" }
    expect(devices.rows.get(phone.dev)?.push).toEqual(pushTarget)
    expect(connector.pushTargets().map((device) => device.push)).toEqual([pushTarget])

    await connector.remove(phone.dev)
    expect(await waitFor(() => phone.closedCode, "the phone to close")).toBe(4003)
    expect(devices.rows.size).toBe(0)
    connector.stop()
  })
})
