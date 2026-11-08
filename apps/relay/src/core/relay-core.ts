import {
  addDeviceMessage,
  authMessage,
  CloseCode,
  decodeFrame,
  deviceId,
  encodeFrame,
  fromB64url,
  leaveDeviceMessage,
  MAX_FRAME_BYTES,
  MAX_PUSH_PAYLOAD_BYTES,
  pairTokenHash,
  parseClientHeader,
  removeDeviceMessage,
  toB64url,
  verifyB64
} from "@arden-hq/relay-protocol"
import type {
  AddDeviceHeader,
  AuthHeader,
  ClientHeader,
  Peer,
  PushHeader,
  PresenceState,
  RelayErrorCode,
  RelayHeader,
  Role
} from "@arden-hq/relay-protocol"
import { noopPusher } from "./pusher.js"
import type { Pusher, PushResult } from "./pusher.js"
import type { DeviceRecord, Store } from "./store.js"

// TODO(relay-compat): send "unknown_device" once installed phones and Macs read it.
const UNKNOWN_DEVICE_CODE = "auth_failed"

/** Per-socket state; JSON-safe so a Durable Object can serialize it across hibernation. */
export type Attachment =
  | { readonly state: "challenged"; readonly nonce: string; readonly opened: number }
  | { readonly state: "pairing"; readonly dev: string; readonly opened: number }
  | { readonly state: "authed"; readonly role: Role; readonly dev: string; readonly heard: number }
  | { readonly state: "closed" }

export interface Conns<S> {
  send(socket: S, frame: Uint8Array): void
  close(socket: S, code: number, reason: string): void
  sockets(): readonly S[]
  attachment(socket: S): Attachment | undefined
  setAttachment(socket: S, attachment: Attachment): void
  lastPing(socket: S): number | undefined
}

const Limits = {
  authTimeoutMs: 10_000,
  pairingTimeoutMs: 5 * 60_000,
  staleMs: 60_000,
  alarmMs: 30_000,
  queueRows: 256,
  queueBytes: 2 * 1024 * 1024,
  queueTtlMs: 24 * 60 * 60_000,
  pairOffers: 8,
  pairOfferTtlMs: 60 * 60_000,
  devices: 32,
  leftTtlMs: 90 * 24 * 60 * 60_000
} as const

export interface RelayCoreOptions<S> {
  readonly mac: string
  readonly conns: Conns<S>
  readonly store: Store
  readonly pusher?: Pusher
  readonly random?: (length: number) => Uint8Array
  readonly scheduleAlarm?: (at: number) => void
}

export class RelayCore<S> {
  readonly #mac: string
  readonly #conns: Conns<S>
  readonly #store: Store
  readonly #pusher: Pusher
  readonly #random: (length: number) => Uint8Array
  readonly #scheduleAlarm: (at: number) => void

  constructor(options: RelayCoreOptions<S>) {
    this.#mac = options.mac
    this.#conns = options.conns
    this.#store = options.store
    this.#pusher = options.pusher ?? noopPusher
    this.#random = options.random ?? ((length) => crypto.getRandomValues(new Uint8Array(length)))
    this.#scheduleAlarm = options.scheduleAlarm ?? (() => {})
  }

  onOpen(socket: S): void {
    const now = Date.now()
    const nonce = toB64url(this.#random(32))
    this.#conns.setAttachment(socket, { state: "challenged", nonce, opened: now })
    this.#send(socket, { t: "challenge", nonce, now })
    this.#scheduleAlarm(now + Limits.authTimeoutMs)
  }

  onFrame(socket: S, data: Uint8Array): void {
    const attachment = this.#conns.attachment(socket)
    if (attachment === undefined || attachment.state === "closed") return
    if (data.length > MAX_FRAME_BYTES)
      return this.#drop(socket, CloseCode.TooBig, "frame too large")
    const frame = decodeFrame(data)
    const header = frame.ok ? parseClientHeader(frame.header) : undefined
    switch (attachment.state) {
      case "challenged":
        if (header?.t !== "auth") return this.#drop(socket, CloseCode.Protocol, "expected auth")
        return this.#authenticate(socket, attachment.nonce, header)
      case "pairing":
        return this.#error(socket, "forbidden", "waiting for the Mac to add this device")
      case "authed": {
        const heard = { ...attachment, heard: Date.now() }
        this.#conns.setAttachment(socket, heard)
        if (header === undefined || !frame.ok)
          return this.#error(socket, "bad_frame", "unreadable frame")
        return this.#dispatch(socket, heard, header, frame.body)
      }
    }
  }

  onClose(socket: S): void {
    const attachment = this.#conns.attachment(socket)
    this.#conns.setAttachment(socket, { state: "closed" })
    if (attachment?.state === "pairing") return this.#pairGone(attachment.dev)
    if (attachment?.state !== "authed") return
    if (this.#socketFor(attachment.dev, socket) !== undefined) return
    this.#markGone(
      attachment.role,
      attachment.dev,
      Math.max(attachment.heard, this.#conns.lastPing(socket) ?? 0)
    )
  }

  onAlarm(): void {
    const now = Date.now()
    for (const socket of this.#conns.sockets()) {
      const attachment = this.#conns.attachment(socket)
      switch (attachment?.state) {
        case undefined:
        case "closed":
          break
        case "challenged":
          if (now - attachment.opened > Limits.authTimeoutMs)
            this.#drop(socket, CloseCode.Timeout, "auth timeout")
          break
        case "pairing":
          if (now - attachment.opened > Limits.pairingTimeoutMs)
            this.#drop(socket, CloseCode.Timeout, "pairing timeout")
          break
        case "authed": {
          const heard = Math.max(attachment.heard, this.#conns.lastPing(socket) ?? 0)
          if (now - heard <= Limits.staleMs) break
          this.#drop(socket, CloseCode.Timeout, "stale")
          if (this.#socketFor(attachment.dev) === undefined)
            this.#markGone(attachment.role, attachment.dev, heard)
          break
        }
      }
    }
    this.#store.deletePairOffersExpiredBy(now)
    this.#store.deleteQueuedBefore(now - Limits.queueTtlMs)
    const live = this.#conns
      .sockets()
      .some((socket) => this.#conns.attachment(socket)?.state !== "closed")
    const oldest = this.#store.listQueued()[0]
    const next = Math.min(
      live ? now + Limits.alarmMs : Infinity,
      oldest === undefined ? Infinity : oldest.storedAt + Limits.queueTtlMs + 1
    )
    if (Number.isFinite(next)) this.#scheduleAlarm(next)
  }

  #authenticate(socket: S, nonce: string, header: AuthHeader): void {
    const fail = (why: string, code: RelayErrorCode = "auth_failed") => {
      this.#error(socket, code, why)
      this.#drop(socket, CloseCode.AuthFailed, why)
    }
    if (header.mac !== this.#mac) return fail("wrong mac")
    const message = authMessage({ mac: header.mac, dev: header.dev, nonce: fromB64url(nonce) })
    const signedBy = (publicKey: string) => verifyB64({ sig: header.sig, message, publicKey })

    if (header.role === "mac") {
      if (header.dev !== this.#mac) return fail("a Mac authenticates as its own id")
      const record = this.#store.getMac()
      if (record !== undefined)
        return signedBy(record.edPub)
          ? this.#admit(socket, "mac", header.dev)
          : fail("bad signature")
      if (header.ed_pub === undefined || deviceId(fromB64url(header.ed_pub)) !== this.#mac) {
        return fail("unknown mac")
      }
      if (!signedBy(header.ed_pub)) return fail("bad signature")
      this.#store.putMac({
        mac: this.#mac,
        edPub: header.ed_pub,
        state: "online",
        lastSeen: Date.now()
      })
      return this.#admit(socket, "mac", header.dev)
    }

    if (this.#store.getMac() === undefined) return fail("unknown mac")
    const device = this.#store.getDevice(header.dev)
    if (device !== undefined)
      return signedBy(device.edPub)
        ? this.#admit(socket, "phone", header.dev)
        : fail("bad signature")
    const { ed_pub, x_pub, name, pair_token } = header
    if (
      ed_pub === undefined ||
      x_pub === undefined ||
      name === undefined ||
      pair_token === undefined
    ) {
      return fail("unknown device", UNKNOWN_DEVICE_CODE)
    }
    if (deviceId(fromB64url(ed_pub)) !== header.dev || !signedBy(ed_pub))
      return fail("bad signature")
    const mac = this.#socketFor(this.#mac)
    if (mac === undefined) {
      this.#error(socket, "mac_offline", "the Mac must be online to pair")
      return this.#drop(socket, CloseCode.AuthFailed, "mac offline")
    }
    if (!this.#store.takePairOffer(pairTokenHash(fromB64url(pair_token)), Date.now()))
      return fail("unknown pair token")
    for (const other of this.#socketsFor(header.dev))
      this.#drop(other, CloseCode.Replaced, "replaced")
    this.#conns.setAttachment(socket, { state: "pairing", dev: header.dev, opened: Date.now() })
    this.#send(socket, { t: "pair_pending" })
    this.#send(mac, { t: "pair_request", dev: header.dev, ed_pub, x_pub, name })
    this.#scheduleAlarm(Date.now() + Limits.alarmMs)
  }

  #admit(socket: S, role: Role, dev: string): void {
    const now = Date.now()
    this.#conns.setAttachment(socket, { state: "authed", role, dev, heard: now })
    for (const other of this.#socketsFor(dev)) {
      if (other !== socket) this.#drop(other, CloseCode.Replaced, "replaced")
    }
    if (role === "mac") {
      this.#store.setMacPresence("online", now)
      this.#broadcast("phone", { t: "presence", dev, state: "online", last_seen: now })
    } else {
      this.#store.touchDevice(dev, now)
      this.#broadcast("mac", { t: "presence", dev, state: "online", last_seen: now })
    }
    this.#send(socket, {
      t: "ready",
      peers: role === "mac" ? this.#phonePeers() : [this.#macPeer()]
    })
    if (role === "mac") {
      this.#store.deleteLeftBefore(now - Limits.leftTtlMs)
      for (const left of this.#store.listLeft())
        this.#send(socket, { t: "device_left", dev: left.dev, sig: left.sig })
      for (const row of this.#store.listQueued())
        this.#send(socket, { t: "queued", id: row.id, from: row.from }, row.body)
    }
    this.#scheduleAlarm(now + Limits.alarmMs)
  }

  #dispatch(
    socket: S,
    self: { role: Role; dev: string },
    header: ClientHeader,
    body: Uint8Array
  ): void {
    if (header.t === "msg") return this.#route(socket, self, header.to, header.id, body)
    if (self.role === "phone") {
      if (header.t === "queued") return this.#enqueue(socket, self.dev, header.id, body)
      if (header.t === "leave") return this.#leave(socket, self.dev, header.sig)
      return this.#error(socket, "forbidden", `a phone cannot send ${header.t}`)
    }
    const now = Date.now()
    switch (header.t) {
      case "auth":
        return this.#error(socket, "bad_frame", "already authenticated")
      case "queued":
        return this.#error(socket, "forbidden", "only phones queue")
      case "qack":
        return this.#store.dequeue(header.id)
      case "presence":
        this.#store.setMacPresence(header.state, now)
        return this.#broadcast("phone", {
          t: "presence",
          dev: this.#mac,
          state: header.state,
          last_seen: now
        })
      case "add_device":
        return this.#addDevice(socket, header)
      case "remove_device": {
        if (!this.#signedByMac(header.sig_mac, removeDeviceMessage({ dev: header.dev }))) {
          return this.#error(socket, "bad_signature", "remove_device signature")
        }
        this.#store.deleteDevice(header.dev)
        this.#store.deleteLeft(header.dev)
        this.#store.deleteQueuedFrom(header.dev)
        for (const other of this.#socketsFor(header.dev))
          this.#drop(other, CloseCode.Revoked, "revoked")
        return this.#send(socket, { t: "device_removed", dev: header.dev })
      }
      case "pair_offer": {
        this.#store.deletePairOffersExpiredBy(now)
        if (header.expires <= now || header.expires > now + Limits.pairOfferTtlMs) {
          return this.#error(
            socket,
            "limit",
            `a pair offer expires within ${Limits.pairOfferTtlMs} ms`
          )
        }
        if (this.#store.countPairOffers() >= Limits.pairOffers)
          return this.#error(socket, "limit", "too many pair offers")
        this.#store.putPairOffer({ tokenHash: header.token_hash, expires: header.expires })
        this.#scheduleAlarm(header.expires)
        return this.#send(socket, { t: "pair_offered", token_hash: header.token_hash })
      }
      case "leave":
        return this.#error(socket, "forbidden", "only phones leave")
      case "pair_deny":
        return this.#denyPairing(header.dev)
      case "push":
        return this.#push(socket, header, body)
    }
  }

  #leave(socket: S, dev: string, sig: string): void {
    const device = this.#store.getDevice(dev)
    if (
      device === undefined ||
      !verifyB64({
        sig,
        message: leaveDeviceMessage({ mac: this.#mac, dev }),
        publicKey: device.edPub
      })
    )
      return this.#error(socket, "bad_signature", "leave signature")
    this.#store.putLeft({ dev, sig, at: Date.now() })
    this.#store.deleteDevice(dev)
    this.#store.deleteQueuedFrom(dev)
    this.#send(socket, { t: "left" })
    const mac = this.#socketFor(this.#mac)
    if (mac !== undefined) this.#send(mac, { t: "device_left", dev, sig })
    for (const other of this.#socketsFor(dev)) this.#drop(other, CloseCode.Left, "left")
  }

  #denyPairing(dev: string): void {
    for (const pending of this.#conns.sockets()) {
      const attachment = this.#conns.attachment(pending)
      if (attachment?.state !== "pairing" || attachment.dev !== dev) continue
      this.#error(pending, "forbidden", "Your Mac said no.")
      this.#drop(pending, CloseCode.Denied, "denied")
    }
  }

  #push(socket: S, header: PushHeader, body: Uint8Array): void {
    const reply = (result: PushResult) =>
      this.#send(socket, { t: "pushed", id: header.id, ...result })
    if (this.#store.getDevice(header.dev) === undefined)
      return reply({ status: "rejected", reason: "UnknownDevice" })
    if (body.length === 0) return reply({ status: "rejected", reason: "PayloadEmpty" })
    if (body.length > MAX_PUSH_PAYLOAD_BYTES)
      return reply({ status: "rejected", reason: "PayloadTooLarge" })
    void this.#pusher
      .push({
        mac: this.#mac,
        dev: header.dev,
        token: header.token,
        env: header.env,
        topic: header.topic,
        collapseId: header.collapse_id,
        priority: header.priority,
        body
      })
      .then(reply, () => reply({ status: "unavailable", reason: "PusherFailed" }))
  }

  #route(
    socket: S,
    self: { role: Role; dev: string },
    to: string,
    id: string,
    body: Uint8Array
  ): void {
    const known = self.role === "phone" ? to === this.#mac : this.#store.getDevice(to) !== undefined
    if (!known || to === self.dev)
      return this.#send(socket, { t: "undeliverable", id, reason: "unknown_peer" })
    const target = this.#socketFor(to)
    if (target === undefined)
      return this.#send(socket, { t: "undeliverable", id, reason: "offline" })
    this.#send(target, { t: "msg", from: self.dev, id }, body)
  }

  #enqueue(socket: S, from: string, id: string, body: Uint8Array): void {
    const usage = this.#store.queueUsage()
    if (usage.rows >= Limits.queueRows || usage.bytes + body.length > Limits.queueBytes) {
      return this.#send(socket, { t: "undeliverable", id, reason: "queue_full" })
    }
    const now = Date.now()
    const result = this.#store.enqueue({ id, from, body, storedAt: now })
    this.#send(socket, { t: "stored", id })
    if (result === "duplicate") return
    const mac = this.#socketFor(this.#mac)
    if (mac !== undefined) this.#send(mac, { t: "queued", id, from }, body)
    this.#scheduleAlarm(now + Limits.queueTtlMs + 1)
  }

  #addDevice(socket: S, header: AddDeviceHeader): void {
    if (deviceId(fromB64url(header.ed_pub)) !== header.dev) {
      return this.#error(socket, "bad_signature", "dev does not match ed_pub")
    }
    if (
      !this.#signedByMac(
        header.sig_mac,
        addDeviceMessage({ dev: header.dev, edPublicKey: fromB64url(header.ed_pub) })
      )
    ) {
      return this.#error(socket, "bad_signature", "add_device signature")
    }
    const existing = this.#store.getDevice(header.dev)
    if (existing === undefined && this.#store.listDevices().length >= Limits.devices) {
      return this.#error(socket, "limit", "too many devices")
    }
    const now = Date.now()
    this.#store.deleteLeft(header.dev)
    this.#store.putDevice({
      dev: header.dev,
      edPub: header.ed_pub,
      name: header.name,
      addedAt: existing?.addedAt ?? now,
      lastSeen: existing?.lastSeen ?? 0
    })
    this.#send(socket, { t: "device_added", dev: header.dev })
    for (const pending of this.#conns.sockets()) {
      const attachment = this.#conns.attachment(pending)
      if (attachment?.state === "pairing" && attachment.dev === header.dev)
        this.#admit(pending, "phone", header.dev)
    }
  }

  #markGone(role: Role, dev: string, lastSeen: number): void {
    if (role === "phone") {
      this.#store.touchDevice(dev, lastSeen)
      return this.#broadcast("mac", { t: "presence", dev, state: "offline", last_seen: lastSeen })
    }
    const state: PresenceState = this.#store.getMac()?.state === "asleep" ? "asleep" : "offline"
    this.#store.setMacPresence(state, lastSeen)
    this.#broadcast("phone", { t: "presence", dev, state, last_seen: lastSeen })
  }

  #macPeer(): Peer {
    const record = this.#store.getMac()
    const socket = this.#socketFor(this.#mac)
    const online = socket !== undefined
    const awake: PresenceState = online ? "online" : "offline"
    const state: PresenceState = record?.state === "asleep" ? "asleep" : awake
    return {
      dev: this.#mac,
      role: "mac",
      name: "",
      online,
      state,
      last_seen: online ? this.#heard(socket) : (record?.lastSeen ?? 0)
    }
  }

  #phonePeers(): Peer[] {
    return this.#store.listDevices().map((device: DeviceRecord): Peer => {
      const socket = this.#socketFor(device.dev)
      return socket === undefined
        ? {
            dev: device.dev,
            role: "phone",
            name: device.name,
            online: false,
            state: "offline",
            last_seen: device.lastSeen
          }
        : {
            dev: device.dev,
            role: "phone",
            name: device.name,
            online: true,
            state: "online",
            last_seen: this.#heard(socket)
          }
    })
  }

  #heard(socket: S): number {
    const attachment = this.#conns.attachment(socket)
    const heard = attachment?.state === "authed" ? attachment.heard : 0
    return Math.max(heard, this.#conns.lastPing(socket) ?? 0)
  }

  #socketsFor(dev: string): S[] {
    return this.#conns.sockets().filter((socket) => {
      const attachment = this.#conns.attachment(socket)
      return (
        (attachment?.state === "authed" || attachment?.state === "pairing") &&
        attachment.dev === dev
      )
    })
  }

  #socketFor(dev: string, except?: S): S | undefined {
    return this.#conns.sockets().find((socket) => {
      const attachment = this.#conns.attachment(socket)
      return socket !== except && attachment?.state === "authed" && attachment.dev === dev
    })
  }

  #broadcast(role: Role, header: RelayHeader): void {
    for (const socket of this.#conns.sockets()) {
      const attachment = this.#conns.attachment(socket)
      if (attachment?.state === "authed" && attachment.role === role) this.#send(socket, header)
    }
  }

  #signedByMac(sig: string, message: Uint8Array): boolean {
    const record = this.#store.getMac()
    return record !== undefined && verifyB64({ sig, message, publicKey: record.edPub })
  }

  #send(socket: S, header: RelayHeader, body?: Uint8Array): void {
    this.#conns.send(socket, encodeFrame(header, body))
  }

  #error(socket: S, code: RelayErrorCode, message: string): void {
    this.#send(socket, { t: "error", code, message })
  }

  #drop(socket: S, code: number, reason: string): void {
    const attachment = this.#conns.attachment(socket)
    this.#conns.setAttachment(socket, { state: "closed" })
    this.#conns.close(socket, code, reason)
    if (attachment?.state === "pairing") this.#pairGone(attachment.dev)
  }

  #pairGone(dev: string): void {
    const mac = this.#socketFor(this.#mac)
    if (mac !== undefined) this.#send(mac, { t: "pair_gone", dev })
  }
}
