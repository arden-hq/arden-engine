import { randomBytes } from "@noble/hashes/utils.js"
import { concat, fromB64url, fromUtf8, toB64url, toHex, utf8 } from "./encoding.js"
import { isRecord } from "@arden-hq/std/json"
import { parseJsonText } from "@arden-hq/std/json-text"

export const APP_MESSAGE_TAG = {
  hs1: "hs1",
  hs2: "hs2",
  resume: "resume",
  req: "req",
  cancel: "cancel",
  sub: "sub",
  unsub: "unsub",
  ack: "ack",
  cmd: "cmd",
  res: "res",
  ev: "ev",
  reset: "reset",
  cmd_ack: "cmd_ack",
  part: "part"
} as const
export type AppMessageTag = (typeof APP_MESSAGE_TAG)[keyof typeof APP_MESSAGE_TAG]

export type HandshakeMessage =
  | { readonly t: typeof APP_MESSAGE_TAG.hs1; readonly e: string }
  | { readonly t: typeof APP_MESSAGE_TAG.hs2; readonly e: string }

export const HTTP_METHOD = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE"
} as const
export type HttpMethod = (typeof HTTP_METHOD)[keyof typeof HTTP_METHOD]

export const COMMAND_KIND = {
  send: "send",
  answer: "answer",
  decide: "decide",
  stop: "stop",
  capture: "capture",
  register_push: "register_push",
  set_keep_awake: "set_keep_awake"
} as const
export type CommandKind = (typeof COMMAND_KIND)[keyof typeof COMMAND_KIND]

export const COMMAND_ACK_STATE = {
  done: "done",
  stopping: "stopping",
  rejected: "rejected"
} as const
export type CommandAckState = (typeof COMMAND_ACK_STATE)[keyof typeof COMMAND_ACK_STATE]

export const RESET_REASON = {
  gap: "gap",
  overflow: "overflow",
  forbidden: "forbidden",
  limit: "limit"
} as const
export type ResetReason = (typeof RESET_REASON)[keyof typeof RESET_REASON]

export interface ResumeMessage {
  readonly t: typeof APP_MESSAGE_TAG.resume
  readonly streams: Readonly<Record<string, number>>
  readonly pending: readonly string[]
}
export interface RequestMessage {
  readonly t: typeof APP_MESSAGE_TAG.req
  readonly rid: string
  readonly method: HttpMethod
  readonly path: string
  readonly body?: unknown
}
export interface CancelMessage {
  readonly t: typeof APP_MESSAGE_TAG.cancel
  readonly rid: string
}
export interface SubscribeMessage {
  readonly t: typeof APP_MESSAGE_TAG.sub
  readonly sid: string
  readonly path: string
  readonly from_seq?: number
}
export interface UnsubscribeMessage {
  readonly t: typeof APP_MESSAGE_TAG.unsub
  readonly sid: string
}
export interface AckMessage {
  readonly t: typeof APP_MESSAGE_TAG.ack
  readonly sid: string
  readonly seq: number
}
export interface CommandMessage {
  readonly t: typeof APP_MESSAGE_TAG.cmd
  readonly cid: string
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
  readonly t: typeof APP_MESSAGE_TAG.res
  readonly rid: string
  readonly status: number
  readonly body: unknown
}
export interface EventMessage {
  readonly t: typeof APP_MESSAGE_TAG.ev
  readonly sid: string
  readonly seq: number
  readonly data: unknown
}
export interface ResetMessage {
  readonly t: typeof APP_MESSAGE_TAG.reset
  readonly sid: string
  readonly reason: ResetReason
}
export interface CommandAckMessage {
  readonly t: typeof APP_MESSAGE_TAG.cmd_ack
  readonly cid: string
  readonly state: CommandAckState
  readonly result?: unknown
}

export type MacMessage = ResponseMessage | EventMessage | ResetMessage | CommandAckMessage

const string = (value: unknown): value is string => typeof value === "string" && value.length > 0
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const oneOf = <V extends string>(
  table: Readonly<Record<string, V>>,
  value: unknown
): V | undefined => Object.values(table).find((candidate) => candidate === value)

export const decodeHandshake = (value: unknown): HandshakeMessage | undefined => {
  if (!isRecord(value) || !string(value["e"])) return undefined
  switch (value["t"]) {
    case APP_MESSAGE_TAG.hs1:
      return { t: APP_MESSAGE_TAG.hs1, e: value["e"] }
    case APP_MESSAGE_TAG.hs2:
      return { t: APP_MESSAGE_TAG.hs2, e: value["e"] }
    default:
      return undefined
  }
}

export const decodePhoneMessage = (value: unknown): PhoneMessage | undefined => {
  if (!isRecord(value)) return undefined
  switch (value["t"]) {
    case APP_MESSAGE_TAG.resume: {
      const streams = value["streams"]
      const pending = value["pending"]
      if (!isRecord(streams) || !Object.values(streams).every(integer)) return undefined
      if (!Array.isArray(pending) || !pending.every(string)) return undefined
      return {
        t: APP_MESSAGE_TAG.resume,
        streams: Object.fromEntries(
          Object.entries(streams).filter((e): e is [string, number] => integer(e[1]))
        ),
        pending
      }
    }
    case APP_MESSAGE_TAG.req: {
      const { rid, method, path } = value
      const knownMethod = oneOf(HTTP_METHOD, method)
      if (!string(rid) || knownMethod === undefined || !string(path)) return undefined
      return "body" in value
        ? { t: APP_MESSAGE_TAG.req, rid, method: knownMethod, path, body: value["body"] }
        : { t: APP_MESSAGE_TAG.req, rid, method: knownMethod, path }
    }
    case APP_MESSAGE_TAG.cancel:
      return string(value["rid"]) ? { t: APP_MESSAGE_TAG.cancel, rid: value["rid"] } : undefined
    case APP_MESSAGE_TAG.sub: {
      const { sid, path, from_seq } = value
      if (!string(sid) || !string(path)) return undefined
      if (from_seq === undefined) return { t: APP_MESSAGE_TAG.sub, sid, path }
      return integer(from_seq) ? { t: APP_MESSAGE_TAG.sub, sid, path, from_seq } : undefined
    }
    case APP_MESSAGE_TAG.unsub:
      return string(value["sid"]) ? { t: APP_MESSAGE_TAG.unsub, sid: value["sid"] } : undefined
    case APP_MESSAGE_TAG.ack: {
      const { sid, seq } = value
      return string(sid) && integer(seq) ? { t: APP_MESSAGE_TAG.ack, sid, seq } : undefined
    }
    case APP_MESSAGE_TAG.cmd: {
      const { cid, ts, kind } = value
      const knownKind = oneOf(COMMAND_KIND, kind)
      if (!string(cid) || !integer(ts) || knownKind === undefined) return undefined
      return { t: APP_MESSAGE_TAG.cmd, cid, ts, kind: knownKind, args: value["args"] }
    }
    default:
      return undefined
  }
}

export const decodeMacMessage = (value: unknown): MacMessage | undefined => {
  if (!isRecord(value)) return undefined
  switch (value["t"]) {
    case APP_MESSAGE_TAG.res: {
      const { rid, status } = value
      return string(rid) && integer(status)
        ? { t: APP_MESSAGE_TAG.res, rid, status, body: value["body"] }
        : undefined
    }
    case APP_MESSAGE_TAG.ev: {
      const { sid, seq } = value
      return string(sid) && integer(seq)
        ? { t: APP_MESSAGE_TAG.ev, sid, seq, data: value["data"] }
        : undefined
    }
    case APP_MESSAGE_TAG.reset: {
      const { sid } = value
      const reason = oneOf(RESET_REASON, value["reason"])
      return string(sid) && reason !== undefined
        ? { t: APP_MESSAGE_TAG.reset, sid, reason }
        : undefined
    }
    case APP_MESSAGE_TAG.cmd_ack: {
      const { cid } = value
      const state = oneOf(COMMAND_ACK_STATE, value["state"])
      if (!string(cid) || state === undefined) return undefined
      return "result" in value
        ? { t: APP_MESSAGE_TAG.cmd_ack, cid, state, result: value["result"] }
        : { t: APP_MESSAGE_TAG.cmd_ack, cid, state }
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

export const PART_THRESHOLD = 64 * 1024
export const PART_BYTES = (PART_THRESHOLD / 4) * 3
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export interface PartMessage {
  readonly t: typeof APP_MESSAGE_TAG.part
  readonly mid: string
  readonly i: number
  readonly n: number
  readonly data: string
}

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
      t: APP_MESSAGE_TAG.part,
      mid,
      i,
      n,
      data: toB64url(json.subarray(i * PART_BYTES, (i + 1) * PART_BYTES))
    }
    return utf8(JSON.stringify(part))
  })
}

export class PartAssembler {
  #current: { mid: string; n: number; chunks: Uint8Array[]; bytes: number } | undefined

  receive(plaintext: Uint8Array): unknown {
    const value: unknown = parseJsonText(fromUtf8(plaintext))
    if (!isRecord(value) || value["t"] !== APP_MESSAGE_TAG.part) {
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
    return parseJsonText(fromUtf8(concat(...current.chunks)))
  }
}
