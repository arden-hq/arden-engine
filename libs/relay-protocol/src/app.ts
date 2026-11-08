import { randomBytes } from "@noble/hashes/utils.js"
import { concat, fromB64url, fromUtf8, toB64url, toHex, utf8 } from "./encoding.js"
import { isRecord } from "@arden-hq/std/json"

export type HandshakeMessage =
  | { readonly t: "hs1"; readonly e: string }
  | { readonly t: "hs2"; readonly e: string }

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type CommandKind =
  | "send"
  | "answer"
  | "decide"
  | "stop"
  | "capture"
  | "register_push"
  | "set_keep_awake"

export interface ResumeMessage {
  readonly t: "resume"
  /** sid → last applied seq. */
  readonly streams: Readonly<Record<string, number>>
  /** cids still in the phone's outbox; the Mac re-acks or runs them. */
  readonly pending: readonly string[]
}
export interface RequestMessage {
  readonly t: "req"
  readonly rid: string
  readonly method: HttpMethod
  readonly path: string
  readonly body?: unknown
}
export interface CancelMessage {
  readonly t: "cancel"
  readonly rid: string
}
export interface SubscribeMessage {
  readonly t: "sub"
  readonly sid: string
  readonly path: string
  readonly from_seq?: number
}
export interface UnsubscribeMessage {
  readonly t: "unsub"
  readonly sid: string
}
export interface AckMessage {
  readonly t: "ack"
  readonly sid: string
  readonly seq: number
}
export interface CommandMessage {
  readonly t: "cmd"
  readonly cid: string
  /** Epoch ms when the phone created the command; the Mac rejects anything older than 24 h. */
  readonly ts: number
  readonly kind: CommandKind
  readonly args: unknown
}

export type PhoneMessage =
  | ResumeMessage
  | RequestMessage
  | CancelMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | AckMessage
  | CommandMessage

export interface ResponseMessage {
  readonly t: "res"
  readonly rid: string
  readonly status: number
  readonly body: unknown
}
export interface EventMessage {
  readonly t: "ev"
  readonly sid: string
  readonly seq: number
  readonly data: unknown
}
export interface ResetMessage {
  readonly t: "reset"
  readonly sid: string
  readonly reason: string
}
export interface CommandAckMessage {
  readonly t: "cmd_ack"
  readonly cid: string
  readonly state: "done" | "stopping" | "rejected"
  readonly result?: unknown
}

export type MacMessage = ResponseMessage | EventMessage | ResetMessage | CommandAckMessage

const string = (value: unknown): value is string => typeof value === "string" && value.length > 0
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const methods: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const kinds: readonly CommandKind[] = [
  "send",
  "answer",
  "decide",
  "stop",
  "capture",
  "register_push",
  "set_keep_awake"
]

export const decodeHandshake = (value: unknown): HandshakeMessage | undefined => {
  if (!isRecord(value) || !string(value["e"])) return undefined
  if (value["t"] === "hs1") return { t: "hs1", e: value["e"] }
  if (value["t"] === "hs2") return { t: "hs2", e: value["e"] }
  return undefined
}

export const decodePhoneMessage = (value: unknown): PhoneMessage | undefined => {
  if (!isRecord(value)) return undefined
  switch (value["t"]) {
    case "resume": {
      const streams = value["streams"]
      const pending = value["pending"]
      if (!isRecord(streams) || !Object.values(streams).every(integer)) return undefined
      if (!Array.isArray(pending) || !pending.every(string)) return undefined
      return {
        t: "resume",
        streams: Object.fromEntries(
          Object.entries(streams).filter((e): e is [string, number] => integer(e[1]))
        ),
        pending
      }
    }
    case "req": {
      const { rid, method, path } = value
      const knownMethod = methods.find((candidate) => candidate === method)
      if (!string(rid) || knownMethod === undefined || !string(path)) return undefined
      return "body" in value
        ? { t: "req", rid, method: knownMethod, path, body: value["body"] }
        : { t: "req", rid, method: knownMethod, path }
    }
    case "cancel":
      return string(value["rid"]) ? { t: "cancel", rid: value["rid"] } : undefined
    case "sub": {
      const { sid, path, from_seq } = value
      if (!string(sid) || !string(path)) return undefined
      if (from_seq === undefined) return { t: "sub", sid, path }
      return integer(from_seq) ? { t: "sub", sid, path, from_seq } : undefined
    }
    case "unsub":
      return string(value["sid"]) ? { t: "unsub", sid: value["sid"] } : undefined
    case "ack": {
      const { sid, seq } = value
      return string(sid) && integer(seq) ? { t: "ack", sid, seq } : undefined
    }
    case "cmd": {
      const { cid, ts, kind } = value
      const knownKind = kinds.find((candidate) => candidate === kind)
      if (!string(cid) || !integer(ts) || knownKind === undefined) return undefined
      return { t: "cmd", cid, ts, kind: knownKind, args: value["args"] }
    }
    default:
      return undefined
  }
}

export const decodeMacMessage = (value: unknown): MacMessage | undefined => {
  if (!isRecord(value)) return undefined
  switch (value["t"]) {
    case "res": {
      const { rid, status } = value
      return string(rid) && integer(status)
        ? { t: "res", rid, status, body: value["body"] }
        : undefined
    }
    case "ev": {
      const { sid, seq } = value
      return string(sid) && integer(seq) ? { t: "ev", sid, seq, data: value["data"] } : undefined
    }
    case "reset": {
      const { sid, reason } = value
      return string(sid) && typeof reason === "string" ? { t: "reset", sid, reason } : undefined
    }
    case "cmd_ack": {
      const { cid, state } = value
      if (!string(cid) || (state !== "done" && state !== "stopping" && state !== "rejected"))
        return undefined
      return "result" in value
        ? { t: "cmd_ack", cid, state, result: value["result"] }
        : { t: "cmd_ack", cid, state }
    }
    default:
      return undefined
  }
}

/** RFC 9562 UUIDv7: 48-bit ms timestamp, version 7, variant 10, 74 random bits. */
export const uuidv7 = ({ now = Date.now(), random = randomBytes(10) } = {}): string => {
  const bytes = new Uint8Array(16)
  const view = new DataView(bytes.buffer)
  // oxlint-disable-next-line arden/restricted-owner -- 2^32 split, not a delay
  view.setUint16(0, Math.floor(now / 2 ** 32))
  view.setUint32(2, now >>> 0)
  bytes.set(random.subarray(0, 10), 6)
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f)
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Messages whose UTF-8 JSON is larger than this travel as `part`s. */
export const PART_THRESHOLD = 64 * 1024
/** Raw bytes per part; base64url makes the `data` field 64 KiB. */
export const PART_BYTES = 48 * 1024
/** A reassembled message may not exceed this. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export interface PartMessage {
  readonly t: "part"
  /** Message id shared by every part (UUIDv7). */
  readonly mid: string
  /** 0-based index. */
  readonly i: number
  readonly n: number
  /** base64url of this slice of the whole message's UTF-8 JSON. */
  readonly data: string
}

/**
 * One app message → the plaintexts to seal, in order: the JSON itself when it
 * fits, else `part`s over its UTF-8 bytes.
 */
export const encodeAppMessage = (
  message: PhoneMessage | MacMessage,
  { newId = () => uuidv7() }: { newId?: () => string } = {}
): Uint8Array[] => {
  const json = utf8(JSON.stringify(message))
  if (json.length <= PART_THRESHOLD) return [json]
  if (json.length > MAX_MESSAGE_BYTES)
    throw new Error(`app message over ${MAX_MESSAGE_BYTES} bytes`)
  const mid = newId()
  const n = Math.ceil(json.length / PART_BYTES)
  return Array.from({ length: n }, (_, i) => {
    const part: PartMessage = {
      t: "part",
      mid,
      i,
      n,
      data: toB64url(json.subarray(i * PART_BYTES, (i + 1) * PART_BYTES))
    }
    return utf8(JSON.stringify(part))
  })
}

/**
 * Receive side of encodeAppMessage, one per session direction. Parts arrive
 * in order on one session, so a part that does not continue the current
 * message is a protocol error (throws). Returns the parsed JSON of a complete
 * message, or undefined while a split message is still arriving.
 */
export class PartAssembler {
  #current: { mid: string; n: number; chunks: Uint8Array[]; bytes: number } | undefined

  receive(plaintext: Uint8Array): unknown {
    const value: unknown = JSON.parse(fromUtf8(plaintext))
    if (!isRecord(value) || value["t"] !== "part") {
      if (this.#current !== undefined)
        throw new Error("message interleaved with an unfinished part sequence")
      return value
    }
    const { mid, i, n, data } = value
    if (!string(mid) || !integer(i) || !integer(n) || n < 1 || typeof data !== "string") {
      throw new Error("malformed part")
    }
    const current = this.#current ?? { mid, n, chunks: [], bytes: 0 }
    if (current.mid !== mid || current.n !== n || current.chunks.length !== i) {
      this.#current = undefined
      throw new Error(`unexpected part ${i}/${n} of ${mid}`)
    }
    const chunk = fromB64url(data)
    current.chunks.push(chunk)
    current.bytes += chunk.length
    if (current.bytes > MAX_MESSAGE_BYTES) {
      this.#current = undefined
      throw new Error(`reassembled message over ${MAX_MESSAGE_BYTES} bytes`)
    }
    if (current.chunks.length < n) {
      this.#current = current
      return undefined
    }
    this.#current = undefined
    return JSON.parse(fromUtf8(concat(...current.chunks)))
  }
}
