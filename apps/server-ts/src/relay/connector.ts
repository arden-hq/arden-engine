import { parseJsonText } from "@arden-hq/protocol/common"
import { RELAY_CONNECTION } from "@arden-hq/protocol/relay"
import { after, every, type Timer } from "@arden-hq/std/timer"
import { ladderDelayMs } from "@arden-hq/std/retry"
import {
  APNS_REASON,
  APP_MESSAGE_TAG,
  HEADER_TAG,
  PRESENCE_STATE,
  PUSH_STATUS,
  RELAY_ERROR_CODE,
  ROLE,
  authMessage,
  bodyAad,
  BodyKind,
  decodeFrame,
  decodeHandshake,
  decodePhoneMessage,
  encodeAppMessage,
  encodeFrame,
  fromB64url,
  fromUtf8,
  generateX25519,
  leaveDeviceMessage,
  macSessionKeys,
  openQueued,
  parseRelayHeader,
  PartAssembler,
  removeDeviceMessage,
  SessionCipher,
  sign,
  toB64url,
  utf8,
  uuidv7,
  verifyB64,
  type ApnsReason,
  type AwakeState,
  type ClientHeader,
  type MacMessage,
  type Peer,
  type RelayHeader
} from "@arden-hq/relay-protocol"
import { WebSocket, type RawData } from "ws"
import type { PairedDevice, PushTarget } from "../persistence/relay/store.js"
import type { MacIdentity } from "./identity.js"
import { PhoneSession } from "./phone.js"
import { RelayPairing, type PairRequest } from "./pairing.js"
import type { CommandLog, DeviceRegistry, Loopback, RelayLog } from "./ports.js"
import { errorMessage } from "@arden-hq/std/errors"
import { currentMillis } from "../runtime/clock.js"

const ConnectorLimits = {
  pingMs: 20_000,
  silentMs: 60_000,
  backoffMs: [1_000, 2_000, 5_000, 10_000, 30_000]
} as const

const APNS_DEAD_TOKEN_REASONS: ReadonlySet<string> = new Set<ApnsReason>([
  APNS_REASON.Unregistered,
  APNS_REASON.BadDeviceToken
])

export const CONNECTOR_STATE = {
  connecting: RELAY_CONNECTION.connecting,
  connected: RELAY_CONNECTION.connected
} as const

export type ConnectorState = (typeof CONNECTOR_STATE)[keyof typeof CONNECTOR_STATE]

interface Link {
  readonly cipher: SessionCipher
  readonly assembler: PartAssembler
}

export interface RelayConnectorOptions {
  readonly identity: MacIdentity
  readonly relayUrl: string
  readonly phoneRelayUrl: string
  readonly macName: string
  readonly devices: DeviceRegistry
  readonly commands: CommandLog
  readonly loopback: Loopback
  readonly log: RelayLog
  readonly setKeepAwake: (on: boolean) => Promise<void>
  readonly onDeviceLeft?: (dev: string) => void
}

export class RelayConnector {
  readonly #options: RelayConnectorOptions
  readonly #devices = new Map<string, PairedDevice>()
  readonly #online = new Set<string>()
  readonly #links = new Map<string, Link>()
  readonly #phones = new Map<string, PhoneSession>()
  readonly #pushes = new Map<string, string>()
  #socket: WebSocket | undefined
  #state: ConnectorState = CONNECTOR_STATE.connecting
  #stopped = false
  #attempt = 0
  #heard = 0
  #heartbeat: Timer | undefined
  #retry: Timer | undefined
  readonly #pairing: RelayPairing

  constructor(options: RelayConnectorOptions) {
    this.#options = options
    this.#pairing = new RelayPairing({
      identity: options.identity,
      phoneRelayUrl: options.phoneRelayUrl,
      macName: options.macName,
      devices: options.devices,
      send: (header) => this.#send(header),
      added: (device) => this.#devices.set(device.dev, device)
    })
  }

  get state(): ConnectorState {
    return this.#state
  }

  get pairRequest(): PairRequest | undefined {
    return this.#pairing.request
  }

  isOnline(dev: string): boolean {
    return this.#online.has(dev)
  }

  async start(): Promise<void> {
    for (const device of await this.#options.devices.list()) this.#devices.set(device.dev, device)
    this.#connect()
  }

  stop(): void {
    this.#stopped = true
    this.#retry?.cancel()
    this.#heartbeat?.cancel()
    this.#pairing.refused()
    for (const phone of this.#phones.values()) phone.close()
    this.#phones.clear()
    this.#links.clear()
    this.#socket?.terminate()
    this.#socket = undefined
  }

  async offer(): Promise<{ readonly link: string; readonly expires: number }> {
    if (this.#state !== CONNECTOR_STATE.connected) throw new Error("The relay is not connected")
    return this.#pairing.offer()
  }

  decide(dev: string, allow: boolean): Promise<boolean> {
    return this.#pairing.decide(dev, allow)
  }

  async remove(dev: string): Promise<void> {
    await this.#forget(dev)
    this.#sendRemove(dev)
  }

  async #forget(dev: string): Promise<void> {
    await this.#options.devices.revoke(dev)
    this.#devices.delete(dev)
    this.#online.delete(dev)
    this.#links.delete(dev)
    this.#phones.get(dev)?.close()
    this.#phones.delete(dev)
  }

  async #onDeviceLeft(dev: string, sig: string): Promise<void> {
    const device = this.#devices.get(dev)
    if (device !== undefined) {
      const signed = verifyB64({
        sig,
        message: leaveDeviceMessage({ mac: this.#options.identity.macId, dev }),
        publicKey: device.edPub
      })
      if (!signed) {
        this.#options.log("warning", "A phone leave was not signed by that phone", { dev })
        return
      }
      await this.#forget(dev)
    }
    this.#sendRemove(dev)
    if (device !== undefined) this.#options.onDeviceLeft?.(dev)
  }

  pushTargets(): ReadonlyArray<PairedDevice & { readonly push: PushTarget }> {
    return [...this.#devices.values()].flatMap((device) =>
      device.push === undefined ? [] : [{ ...device, push: device.push }]
    )
  }

  push(input: {
    readonly device: PairedDevice & { readonly push: PushTarget }
    readonly collapseId: string
    readonly category: string | undefined
    readonly payload: Uint8Array
  }): boolean {
    if (this.#state !== CONNECTOR_STATE.connected || this.#socket?.readyState !== WebSocket.OPEN)
      return false
    const id = uuidv7()
    if (this.#pushes.size > 256) this.#pushes.clear()
    this.#pushes.set(id, input.device.dev)
    const header = {
      t: "push" as const,
      id,
      dev: input.device.dev,
      token: input.device.push.token,
      env: input.device.push.env,
      topic: input.device.push.topic,
      collapse_id: input.collapseId,
      priority: "high" as const
    }
    this.#send(
      input.category === undefined ? header : { ...header, category: input.category },
      input.payload
    )
    return true
  }

  presence(state: AwakeState): void {
    this.#send({ t: "presence", state })
  }

  #connect(): void {
    if (this.#stopped) return
    const { relayUrl, identity } = this.#options
    const socket = new WebSocket(`${relayUrl.replace(/\/+$/, "")}/v1/connect?mac=${identity.macId}`)
    this.#socket = socket
    this.#setState(CONNECTOR_STATE.connecting)
    this.#heard = currentMillis()
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (this.#socket !== socket) return
      this.#heard = currentMillis()
      if (isBinary) this.#onFrame(bytesOf(data))
    })
    socket.on("open", () => {
      this.#heartbeat?.cancel()
      const beat = (): void => {
        if (currentMillis() - this.#heard > ConnectorLimits.silentMs) socket.terminate()
        else if (socket.readyState === WebSocket.OPEN) socket.send("ping")
      }
      this.#heartbeat = every(ConnectorLimits.pingMs, beat, { unref: true })
    })
    socket.on("error", () => {})
    socket.on("close", (code: number) => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#heartbeat?.cancel()
      this.#dropAllLinks()
      this.#online.clear()
      this.#setState(CONNECTOR_STATE.connecting)
      if (this.#stopped) return
      this.#attempt += 1
      const delay = ladderDelayMs(ConnectorLimits.backoffMs, this.#attempt)
      this.#options.log("info", "Relay connection closed", { code, retryMs: delay })
      this.#retry = after(delay, () => this.#connect(), { unref: true })
    })
  }

  #send(header: ClientHeader, body?: Uint8Array): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(encodeFrame(header, body))
  }

  #onFrame(data: Uint8Array): void {
    const frame = decodeFrame(data)
    const header = frame.ok ? parseRelayHeader(frame.header) : undefined
    if (!frame.ok || header === undefined) return
    void this.#dispatch(header, frame.body).catch((cause: unknown) =>
      this.#options.log("warning", "Relay frame failed", {
        frame: header.t,
        cause: errorMessage(cause)
      })
    )
  }

  async #dispatch(header: RelayHeader, body: Uint8Array): Promise<void> {
    switch (header.t) {
      case HEADER_TAG.challenge: {
        const { identity } = this.#options
        const signature = sign(
          authMessage({
            mac: identity.macId,
            dev: identity.macId,
            nonce: fromB64url(header.nonce)
          }),
          identity.ed.secretKey
        )
        this.#send({
          t: "auth",
          mac: identity.macId,
          dev: identity.macId,
          role: "mac",
          sig: toB64url(signature),
          ed_pub: toB64url(identity.ed.publicKey)
        })
        return
      }
      case HEADER_TAG.ready:
        this.#attempt = 0
        this.#setState(CONNECTOR_STATE.connected)
        return this.#reconcile(header.peers)
      case HEADER_TAG.msg:
        return this.#onMessage(header.from, body)
      case HEADER_TAG.queued:
        return this.#onQueued(header.id, header.from, body)
      case HEADER_TAG.presence: {
        if (!this.#devices.has(header.dev)) return
        if (header.state === PRESENCE_STATE.online) this.#online.add(header.dev)
        else {
          this.#online.delete(header.dev)
          this.#dropLink(header.dev)
        }
        const at = header.last_seen > 0 ? header.last_seen : currentMillis()
        return this.#options.devices.seen(header.dev, new Date(at))
      }
      case HEADER_TAG.pair_request:
        return this.#pairing.requested(header)
      case HEADER_TAG.pair_gone:
        return this.#pairing.gone(header.dev)
      case HEADER_TAG.pair_offered:
        return this.#pairing.offered(header.token_hash)
      case HEADER_TAG.error:
        if (header.code === RELAY_ERROR_CODE.limit) this.#pairing.refused()
        this.#options.log("warning", "The relay refused a frame", { code: header.code })
        return
      case HEADER_TAG.device_left:
        return this.#onDeviceLeft(header.dev, header.sig)
      case HEADER_TAG.pair_pending:
      case HEADER_TAG.stored:
      case HEADER_TAG.undeliverable:
      case HEADER_TAG.device_added:
      case HEADER_TAG.device_removed:
      case HEADER_TAG.left:
        return
      case HEADER_TAG.pushed: {
        const dev = this.#pushes.get(header.id)
        this.#pushes.delete(header.id)
        if (header.status === PUSH_STATUS.accepted || dev === undefined) return
        this.#options.log("warning", "A notification did not reach the phone", {
          status: header.status,
          reason: header.reason
        })
        if (header.status === PUSH_STATUS.rejected && APNS_DEAD_TOKEN_REASONS.has(header.reason))
          await this.#setPush(dev, undefined)
        return
      }
    }
  }

  async #reconcile(peers: ReadonlyArray<Peer>): Promise<void> {
    this.#online.clear()
    for (const peer of peers) {
      if (peer.role !== ROLE.phone) continue
      if (!this.#devices.has(peer.dev)) {
        this.#sendRemove(peer.dev)
        continue
      }
      if (peer.online) this.#online.add(peer.dev)
      if (peer.last_seen > 0) await this.#options.devices.seen(peer.dev, new Date(peer.last_seen))
    }
  }

  #sendRemove(dev: string): void {
    const signature = sign(removeDeviceMessage({ dev }), this.#options.identity.ed.secretKey)
    this.#send({ t: "remove_device", dev, sig_mac: toB64url(signature) })
  }

  #onMessage(from: string, body: Uint8Array): void {
    const device = this.#devices.get(from)
    if (device === undefined) return
    if (body[0] === BodyKind.Handshake) return this.#handshake(device, body)
    const link = this.#links.get(from)
    if (link === undefined || body[0] !== BodyKind.Frame) return
    try {
      const plaintext = link.cipher.open(
        body,
        bodyAad({ sender: from, receiver: this.#options.identity.macId })
      )
      const value = link.assembler.receive(plaintext)
      if (value === undefined) return
      const message = decodePhoneMessage(value)
      if (message === undefined) throw new Error("unknown app message")
      this.#phone(from).handle(message)
    } catch (cause) {
      this.#options.log("warning", "Phone session dropped", {
        cause: errorMessage(cause)
      })
      this.#dropLink(from)
    }
  }

  #handshake(device: PairedDevice, body: Uint8Array): void {
    const hello = decodeHandshake(parseJson(body))
    if (hello?.t !== APP_MESSAGE_TAG.hs1) return
    const ephemeral = generateX25519()
    let cipher: SessionCipher
    try {
      cipher = SessionCipher.forMac(
        macSessionKeys({
          macStatic: this.#options.identity.x,
          macEphemeral: ephemeral,
          phoneStaticPublic: fromB64url(device.xPub),
          phoneEphemeralPublic: fromB64url(hello.e)
        })
      )
    } catch {
      return
    }
    this.#dropLink(device.dev)
    this.#send(
      { t: "msg", to: device.dev, id: uuidv7() },
      utf8(JSON.stringify({ t: "hs2", e: toB64url(ephemeral.publicKey) }))
    )
    this.#links.set(device.dev, { cipher, assembler: new PartAssembler() })
    this.#online.add(device.dev)
    this.#phone(device.dev).attach((message) => this.#sendApp(device.dev, message))
  }

  #sendApp(dev: string, message: MacMessage): void {
    const link = this.#links.get(dev)
    if (link === undefined) return
    const aad = bodyAad({ sender: this.#options.identity.macId, receiver: dev })
    for (const plaintext of encodeAppMessage(message)) {
      this.#send({ t: "msg", to: dev, id: uuidv7() }, link.cipher.seal(plaintext, aad))
    }
  }

  async #onQueued(id: string, from: string, body: Uint8Array): Promise<void> {
    const device = this.#devices.get(from)
    try {
      if (device === undefined) return
      const plaintext = openQueued({
        macStatic: this.#options.identity.x,
        phoneStaticPublic: fromB64url(device.xPub),
        body,
        aad: bodyAad({ sender: from, receiver: this.#options.identity.macId })
      })
      const message = decodePhoneMessage(parseJson(plaintext))
      if (message?.t === APP_MESSAGE_TAG.cmd) await this.#phone(from).command(message)
    } catch (cause) {
      this.#options.log("warning", "Queued phone command dropped", {
        cause: errorMessage(cause)
      })
    } finally {
      this.#send({ t: "qack", id })
    }
  }

  async #setPush(dev: string, push: PushTarget | undefined): Promise<void> {
    await this.#options.devices.setPush(dev, push)
    const device = this.#devices.get(dev)
    if (device !== undefined) this.#devices.set(dev, { ...device, push })
  }

  #phone(dev: string): PhoneSession {
    const existing = this.#phones.get(dev)
    if (existing !== undefined) return existing
    const phone = new PhoneSession({
      dev,
      loopback: this.#options.loopback,
      commands: this.#options.commands,
      log: this.#options.log,
      registerPush: (push) => this.#setPush(dev, push),
      setKeepAwake: this.#options.setKeepAwake
    })
    this.#phones.set(dev, phone)
    return phone
  }

  #dropLink(dev: string): void {
    if (!this.#links.delete(dev)) return
    this.#phones.get(dev)?.detach()
  }

  #dropAllLinks(): void {
    for (const dev of [...this.#links.keys()]) this.#dropLink(dev)
  }

  #setState(state: ConnectorState): void {
    if (this.#state === state) return
    this.#state = state
  }
}

const bytesOf = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return parseJsonText(fromUtf8(bytes))
  } catch {
    return undefined
  }
}
