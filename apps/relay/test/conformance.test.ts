import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  addDeviceMessage,
  authMessage,
  CloseCode,
  deviceId,
  fromB64url,
  generateEd25519,
  generateX25519,
  leaveDeviceMessage,
  pairCode,
  pairTokenHash,
  removeDeviceMessage,
  sign,
  toB64url,
  utf8
} from "@arden-hq/relay-protocol"
import type { Ed25519KeyPair, X25519KeyPair } from "@arden-hq/relay-protocol"
import type { Pusher, PushRequest } from "../src/core/pusher.js"
import { bunHarness } from "./harness.js"
import type { Client, Harness } from "./harness.js"

interface Device {
  readonly ed: Ed25519KeyPair
  readonly x: X25519KeyPair
  readonly id: string
}

const makeDevice = (): Device => {
  const ed = generateEd25519()
  return { ed, x: generateX25519(), id: deviceId(ed.publicKey) }
}

const b64 = toB64url
const unregisteredToken = "0f".repeat(32)

const authenticate = async (
  client: Client,
  input: { mac: string; device: Device; role: "mac" | "phone"; extra?: Record<string, string> }
): Promise<void> => {
  const { header } = await client.next("challenge")
  const sig = sign(
    authMessage({ mac: input.mac, dev: input.device.id, nonce: fromB64url(header.nonce) }),
    input.device.ed.secretKey
  )
  client.send({
    t: "auth",
    mac: input.mac,
    dev: input.device.id,
    role: input.role,
    sig: b64(sig),
    ...input.extra
  })
}

describe("Bun relay (WebSocket + bun:sqlite)", () => {
  let harness: Harness
  let mac: Device
  let pushes: PushRequest[]

  beforeEach(() => {
    pushes = []
    const pusher: Pusher = {
      push: (request) => {
        pushes.push(request)
        return Promise.resolve(
          request.token === unregisteredToken
            ? { status: "rejected", reason: "Unregistered" }
            : { status: "accepted" }
        )
      }
    }
    harness = bunHarness({ pusher })
    mac = makeDevice()
  })
  afterEach(async () => {
    await harness.stop()
  })

  const connectMac = async (options: { register?: boolean } = {}): Promise<Client> => {
    const client = await harness.connect(mac.id)
    await authenticate(client, {
      mac: mac.id,
      device: mac,
      role: "mac",
      ...(options.register === true ? { extra: { ed_pub: b64(mac.ed.publicKey) } } : {})
    })
    return client
  }

  const connectPhone = async (phone: Device): Promise<Client> => {
    const client = await harness.connect(mac.id)
    await authenticate(client, { mac: mac.id, device: phone, role: "phone" })
    return client
  }

  const paired = async () => {
    const macClient = await connectMac({ register: true })
    await macClient.next("ready")
    const phone = makeDevice()
    const token = crypto.getRandomValues(new Uint8Array(32))
    macClient.send({
      t: "pair_offer",
      token_hash: pairTokenHash(token),
      expires: harness.now() + 10 * 60_000
    })
    await macClient.next("pair_offered")
    const phoneClient = await harness.connect(mac.id)
    await authenticate(phoneClient, {
      mac: mac.id,
      device: phone,
      role: "phone",
      extra: {
        ed_pub: b64(phone.ed.publicKey),
        x_pub: b64(phone.x.publicKey),
        name: "Test iPhone",
        pair_token: b64(token)
      }
    })
    await phoneClient.next("pair_pending")
    const { header: request } = await macClient.next("pair_request")
    macClient.send({
      t: "add_device",
      dev: request.dev,
      ed_pub: request.ed_pub,
      name: request.name,
      sig_mac: b64(
        sign(
          addDeviceMessage({ dev: request.dev, edPublicKey: fromB64url(request.ed_pub) }),
          mac.ed.secretKey
        )
      )
    })
    await macClient.next("device_added")
    return { macClient, phone, phoneClient, token, request }
  }

  it("registers a Mac on first connect and recognizes it after", async () => {
    const first = await connectMac({ register: true })
    expect((await first.next("ready")).header).toEqual({ t: "ready", peers: [] })
    first.close()
    const second = await connectMac()
    expect((await second.next("ready")).header).toEqual({ t: "ready", peers: [] })
  })

  it("rejects bad auth: wrong key, mismatched id, unknown phone", async () => {
    const registered = await connectMac({ register: true })
    await registered.next("ready")

    const impostor = await harness.connect(mac.id)
    await authenticate(impostor, {
      mac: mac.id,
      device: { ...makeDevice(), id: mac.id },
      role: "mac"
    })
    expect((await impostor.next("error")).header.code).toBe("auth_failed")
    expect(await impostor.closed).toBe(CloseCode.AuthFailed)

    const other = makeDevice()
    const mismatched = await harness.connect(other.id)
    await authenticate(mismatched, {
      mac: other.id,
      device: { ...other, id: other.id },
      role: "mac",
      extra: { ed_pub: b64(mac.ed.publicKey) }
    })
    expect(await mismatched.closed).toBe(CloseCode.AuthFailed)

    const stranger = await connectPhone(makeDevice())
    expect(await stranger.closed).toBe(CloseCode.AuthFailed)
  })

  it("pairs a phone: offer, request with matching code, add_device, ready", async () => {
    const { macClient, phone, phoneClient, token, request } = await paired()
    expect(request).toEqual({
      t: "pair_request",
      dev: phone.id,
      ed_pub: b64(phone.ed.publicKey),
      x_pub: b64(phone.x.publicKey),
      name: "Test iPhone"
    })
    const phoneCode = pairCode({
      token,
      phoneEdPublicKey: phone.ed.publicKey,
      phoneXPublicKey: phone.x.publicKey
    })
    const macCode = pairCode({
      token,
      phoneEdPublicKey: fromB64url(request.ed_pub),
      phoneXPublicKey: fromB64url(request.x_pub)
    })
    expect(macCode).toBe(phoneCode)

    const ready = (await phoneClient.next("ready")).header
    expect(
      ready.peers.map(({ dev, role, online, state }) => ({ dev, role, online, state }))
    ).toEqual([{ dev: mac.id, role: "mac", online: true, state: "online" }])
    expect((await macClient.next("presence")).header).toMatchObject({
      dev: phone.id,
      state: "online"
    })

    const again = await harness.connect(mac.id)
    const second = makeDevice()
    await authenticate(again, {
      mac: mac.id,
      device: second,
      role: "phone",
      extra: {
        ed_pub: b64(second.ed.publicKey),
        x_pub: b64(second.x.publicKey),
        name: "Other",
        pair_token: b64(token)
      }
    })
    expect(await again.closed).toBe(CloseCode.AuthFailed)

    phoneClient.close()
    const back = await connectPhone(phone)
    expect((await back.next("ready")).header.peers).toHaveLength(1)
  })

  it("routes msg bodies both ways unchanged and reports undeliverable", async () => {
    const { macClient, phone, phoneClient } = await paired()
    await phoneClient.next("ready")

    const toMac = crypto.getRandomValues(new Uint8Array(64))
    phoneClient.send({ t: "msg", to: mac.id, id: "f1" }, toMac)
    const atMac = await macClient.next("msg")
    expect(atMac.header).toEqual({ t: "msg", from: phone.id, id: "f1" })
    expect(atMac.body).toEqual(toMac)
    const toPhone = crypto.getRandomValues(new Uint8Array(64))
    macClient.send({ t: "msg", to: phone.id, id: "f2" }, toPhone)
    const atPhone = await phoneClient.next("msg")
    expect(atPhone.header).toEqual({ t: "msg", from: mac.id, id: "f2" })
    expect(atPhone.body).toEqual(toPhone)

    const nobody = makeDevice().id
    macClient.send({ t: "msg", to: nobody, id: "x1" })
    expect((await macClient.next("undeliverable")).header).toEqual({
      t: "undeliverable",
      id: "x1",
      reason: "unknown_peer"
    })
    phoneClient.send({ t: "msg", to: nobody, id: "x2" })
    expect((await phoneClient.next("undeliverable")).header).toEqual({
      t: "undeliverable",
      id: "x2",
      reason: "unknown_peer"
    })

    phoneClient.close()
    await macClient.next("presence")
    macClient.send({ t: "msg", to: phone.id, id: "x3" })
    expect((await macClient.next("undeliverable")).header).toEqual({
      t: "undeliverable",
      id: "x3",
      reason: "offline"
    })
  })

  it("queues sealed blobs while the Mac is away, flushes after ready, deletes on qack", async () => {
    const { macClient, phone, phoneClient } = await paired()
    await phoneClient.next("ready")
    macClient.close()
    expect((await phoneClient.next("presence")).header).toMatchObject({
      dev: mac.id,
      state: "offline"
    })

    const blob = crypto.getRandomValues(new Uint8Array(96))
    phoneClient.send({ t: "queued", id: "q1" }, blob)
    expect((await phoneClient.next("stored")).header).toEqual({ t: "stored", id: "q1" })
    phoneClient.send({ t: "queued", id: "q1" }, blob)
    await phoneClient.next("stored")

    const back = await connectMac()
    await back.next("ready")
    const queued = await back.next("queued")
    expect(queued.header).toEqual({ t: "queued", id: "q1", from: phone.id })
    expect(queued.body).toEqual(blob)
    back.send({ t: "qack", id: "q1" })
    back.close()
    await phoneClient.next("presence")

    const third = await connectMac()
    await third.next("ready")
    phoneClient.send({ t: "msg", to: mac.id, id: "after" })
    await third.next("msg")
    expect(third.pending()).not.toContain("queued")
  })

  it("refuses queued blobs past the byte cap", async () => {
    const { macClient, phoneClient } = await paired()
    await phoneClient.next("ready")
    macClient.close()
    await phoneClient.next("presence")
    const blob = new Uint8Array(240 * 1024).fill(2)
    const fits = Math.floor((2 * 1024 * 1024) / blob.length)
    for (let i = 0; i < fits; i++) {
      phoneClient.send({ t: "queued", id: `q${i}` }, blob)
      await phoneClient.next("stored")
    }
    phoneClient.send({ t: "queued", id: "over" }, blob)
    expect((await phoneClient.next("undeliverable")).header).toEqual({
      t: "undeliverable",
      id: "over",
      reason: "queue_full"
    })
  })

  it("tracks presence: asleep survives the disconnect, silence goes offline after 60 s", async () => {
    const { macClient, phoneClient } = await paired()
    await phoneClient.next("ready")
    macClient.send({ t: "presence", state: "asleep" })
    expect((await phoneClient.next("presence")).header).toMatchObject({
      dev: mac.id,
      state: "asleep"
    })
    macClient.close()
    expect((await phoneClient.next("presence")).header).toMatchObject({
      dev: mac.id,
      state: "asleep"
    })

    const awake = await connectMac()
    await awake.next("ready")
    expect((await phoneClient.next("presence")).header).toMatchObject({
      dev: mac.id,
      state: "online"
    })

    harness.advance(60_000 + 1_000)
    phoneClient.sendText("ping")
    expect(await phoneClient.nextText()).toBe("pong")
    harness.tick()
    expect(await awake.closed).toBe(CloseCode.Timeout)
    expect((await phoneClient.next("presence")).header).toMatchObject({
      dev: mac.id,
      state: "offline"
    })
  })

  it("revokes a phone: its socket closes at once and its key stops working", async () => {
    const { macClient, phone, phoneClient } = await paired()
    await phoneClient.next("ready")
    macClient.send({
      t: "remove_device",
      dev: phone.id,
      sig_mac: b64(sign(removeDeviceMessage({ dev: phone.id }), makeDevice().ed.secretKey))
    })
    expect((await macClient.next("error")).header.code).toBe("bad_signature")
    macClient.send({
      t: "remove_device",
      dev: phone.id,
      sig_mac: b64(sign(removeDeviceMessage({ dev: phone.id }), mac.ed.secretKey))
    })
    expect((await macClient.next("device_removed")).header).toEqual({
      t: "device_removed",
      dev: phone.id
    })
    expect(await phoneClient.closed).toBe(CloseCode.Revoked)
    const retry = await connectPhone(phone)
    expect(await retry.closed).toBe(CloseCode.AuthFailed)
  })

  it("lets a phone leave only as itself, keeps the fact for a sleeping Mac until it answers", async () => {
    const { macClient, phone, phoneClient } = await paired()
    await phoneClient.next("ready")
    const other = makeDevice()
    const signed = (signer: Device, dev: string) =>
      b64(sign(leaveDeviceMessage({ mac: mac.id, dev }), signer.ed.secretKey))

    phoneClient.send({ t: "leave", sig: signed(other, phone.id) })
    expect((await phoneClient.next("error")).header.code).toBe("bad_signature")
    phoneClient.send({ t: "leave", sig: signed(mac, phone.id) })
    expect((await phoneClient.next("error")).header.code).toBe("bad_signature")
    macClient.send({ t: "leave", sig: signed(phone, phone.id) })
    expect((await macClient.next("error")).header.code).toBe("forbidden")

    macClient.close()
    await macClient.closed
    const sig = signed(phone, phone.id)
    phoneClient.send({ t: "leave", sig })
    await phoneClient.next("left")
    expect(await phoneClient.closed).toBe(CloseCode.Left)
    expect(await (await connectPhone(phone)).closed).toBe(CloseCode.AuthFailed)

    const again = await connectMac()
    expect((await again.next("device_left")).header).toEqual({
      t: "device_left",
      dev: phone.id,
      sig
    })
    expect((await again.next("ready")).header.peers).toEqual([])
    again.close()
    await again.closed
    const third = await connectMac()
    await third.next("device_left")
    third.send({
      t: "remove_device",
      dev: phone.id,
      sig_mac: b64(sign(removeDeviceMessage({ dev: phone.id }), mac.ed.secretKey))
    })
    await third.next("device_removed")
    third.close()
    await third.closed
    const fourth = await connectMac()
    expect((await fourth.next("ready")).header.t).toBe("ready")
    expect(fourth.pending()).not.toContain("device_left")
  })

  it("denies a pairing phone: it hears why, closes, and stays unregistered", async () => {
    const macClient = await connectMac({ register: true })
    await macClient.next("ready")
    const phone = makeDevice()
    const token = crypto.getRandomValues(new Uint8Array(32))
    macClient.send({
      t: "pair_offer",
      token_hash: pairTokenHash(token),
      expires: harness.now() + 10 * 60_000
    })
    await macClient.next("pair_offered")
    const phoneClient = await harness.connect(mac.id)
    await authenticate(phoneClient, {
      mac: mac.id,
      device: phone,
      role: "phone",
      extra: {
        ed_pub: b64(phone.ed.publicKey),
        x_pub: b64(phone.x.publicKey),
        name: "Test iPhone",
        pair_token: b64(token)
      }
    })
    await phoneClient.next("pair_pending")
    await macClient.next("pair_request")
    macClient.send({ t: "pair_deny", dev: phone.id })
    expect((await phoneClient.next("error")).header).toEqual({
      t: "error",
      code: "forbidden",
      message: "Your Mac said no."
    })
    expect(await phoneClient.closed).toBe(CloseCode.Denied)
    const retry = await connectPhone(phone)
    expect(await retry.closed).toBe(CloseCode.AuthFailed)
  })

  it("tells the Mac when a pairing phone leaves before it decides", async () => {
    const macClient = await connectMac({ register: true })
    await macClient.next("ready")
    const phone = makeDevice()
    const token = crypto.getRandomValues(new Uint8Array(32))
    macClient.send({
      t: "pair_offer",
      token_hash: pairTokenHash(token),
      expires: harness.now() + 10 * 60_000
    })
    await macClient.next("pair_offered")
    const phoneClient = await harness.connect(mac.id)
    await authenticate(phoneClient, {
      mac: mac.id,
      device: phone,
      role: "phone",
      extra: {
        ed_pub: b64(phone.ed.publicKey),
        x_pub: b64(phone.x.publicKey),
        name: "Test iPhone",
        pair_token: b64(token)
      }
    })
    await phoneClient.next("pair_pending")
    await macClient.next("pair_request")
    phoneClient.close()
    expect((await macClient.next("pair_gone")).header).toEqual({ t: "pair_gone", dev: phone.id })
  })

  it("keeps phones from Mac-only frames", async () => {
    const { phone, phoneClient } = await paired()
    await phoneClient.next("ready")
    phoneClient.send({ t: "remove_device", dev: phone.id, sig_mac: b64(new Uint8Array(64)) })
    expect((await phoneClient.next("error")).header.code).toBe("forbidden")
  })

  it("pushes only from the Mac, only to its registered phones, under the size cap", async () => {
    const { macClient, phone, phoneClient } = await paired()
    await phoneClient.next("ready")
    const push = {
      t: "push",
      id: "p1",
      dev: phone.id,
      token: "ab".repeat(32),
      env: "sandbox",
      topic: "com.arden.ios",
      collapse_id: "ask_1",
      category: "arden.approval",
      priority: "high"
    } as const
    const payload = utf8('{"aps":{"alert":"An approval request"},"e":"sealed"}')

    macClient.send(push, payload)
    expect((await macClient.next("pushed")).header).toEqual({
      t: "pushed",
      id: "p1",
      status: "accepted"
    })
    expect(pushes).toEqual([
      {
        mac: mac.id,
        dev: phone.id,
        token: push.token,
        env: "sandbox",
        topic: "com.arden.ios",
        collapseId: "ask_1",
        priority: "high",
        body: payload
      }
    ])

    macClient.send({ ...push, id: "p2", token: unregisteredToken }, payload)
    expect((await macClient.next("pushed")).header).toEqual({
      t: "pushed",
      id: "p2",
      status: "rejected",
      reason: "Unregistered"
    })
    macClient.send({ ...push, id: "p3", dev: makeDevice().id }, payload)
    expect((await macClient.next("pushed")).header).toEqual({
      t: "pushed",
      id: "p3",
      status: "rejected",
      reason: "UnknownDevice"
    })
    macClient.send({ ...push, id: "p4" }, new Uint8Array(4097))
    expect((await macClient.next("pushed")).header).toEqual({
      t: "pushed",
      id: "p4",
      status: "rejected",
      reason: "PayloadTooLarge"
    })
    phoneClient.send({ ...push, id: "p5" }, payload)
    expect((await phoneClient.next("error")).header.code).toBe("forbidden")
    expect(pushes.length).toBe(2)
  })
})
