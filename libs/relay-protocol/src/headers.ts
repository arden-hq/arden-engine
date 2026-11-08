import { isRecord } from "@arden-hq/std/json"

export type Role = "mac" | "phone"
export type PresenceState = "online" | "asleep" | "offline"

const devPattern = /^[A-Za-z0-9_-]{22}$/
const idPattern = /^[A-Za-z0-9_-]{1,64}$/
const key32Pattern = /^[A-Za-z0-9_-]{43}$/
const sig64Pattern = /^[A-Za-z0-9_-]{86}$/
const apnsTokenPattern = /^[0-9a-fA-F]{64,200}$/
const topicPattern = /^[A-Za-z0-9.-]{1,128}$/
const categoryPattern = /^[A-Za-z0-9._-]{1,64}$/

export const isDeviceId = (value: unknown): value is string =>
  typeof value === "string" && devPattern.test(value)

/**
 * `ed_pub` registers a Mac on its first connect. A phone that is not yet
 * registered adds `ed_pub`, `x_pub`, `name` and the QR's `pair_token`.
 */
export interface AuthHeader {
  readonly t: "auth"
  readonly mac: string
  readonly dev: string
  readonly role: Role
  readonly sig: string
  readonly ed_pub?: string
  readonly x_pub?: string
  readonly name?: string
  readonly pair_token?: string
}
export interface MsgOutHeader {
  readonly t: "msg"
  readonly to: string
  readonly id: string
}
export interface QueuedOutHeader {
  readonly t: "queued"
  readonly id: string
}
export interface QackHeader {
  readonly t: "qack"
  readonly id: string
}
export interface PresenceOutHeader {
  readonly t: "presence"
  readonly state: "online" | "asleep"
}
export interface AddDeviceHeader {
  readonly t: "add_device"
  readonly dev: string
  readonly ed_pub: string
  readonly name: string
  readonly sig_mac: string
}
export interface RemoveDeviceHeader {
  readonly t: "remove_device"
  readonly dev: string
  readonly sig_mac: string
}
/**
 * A phone unpaired. `sig` is the phone's own signature over leaveDeviceMessage
 * (mac, its dev); there is no `dev` field, so a phone can only ever leave as
 * itself. The relay forgets the phone and keeps the fact for the Mac until the
 * Mac answers with remove_device.
 */
export interface LeaveHeader {
  readonly t: "leave"
  readonly sig: string
}
/** The Mac refuses a phone waiting in pairing; the relay tells it so and closes it. */
export interface PairDenyHeader {
  readonly t: "pair_deny"
  readonly dev: string
}
export interface PairOfferHeader {
  readonly t: "pair_offer"
  /** b64url(sha256(raw pair token bytes)). */
  readonly token_hash: string
  /** Epoch ms. */
  readonly expires: number
}
export type ApnsEnvironment = "sandbox" | "production"
/**
 * Body = the APNs payload JSON (fallback text + a sealed blob), at most
 * MAX_PUSH_PAYLOAD_BYTES. The relay answers `pushed` with the same `id`.
 */
export interface PushHeader {
  readonly t: "push"
  readonly id: string
  readonly dev: string
  /** Hex APNs device token. */
  readonly token: string
  readonly env: ApnsEnvironment
  /** The app's bundle id. */
  readonly topic: string
  readonly collapse_id: string
  /** Absent for a finished chat. */
  readonly category?: string
  readonly priority: "high" | "normal"
}

/** Apple's limit for a regular remote notification payload. */
export const MAX_PUSH_PAYLOAD_BYTES = 4096

export type ClientHeader =
  | AuthHeader
  | MsgOutHeader
  | QueuedOutHeader
  | QackHeader
  | PresenceOutHeader
  | AddDeviceHeader
  | RemoveDeviceHeader
  | LeaveHeader
  | PairOfferHeader
  | PairDenyHeader
  | PushHeader

export interface Peer {
  readonly dev: string
  readonly role: Role
  readonly name: string
  readonly online: boolean
  readonly state: PresenceState
  /** Epoch ms of the last frame heard; 0 when never connected. */
  readonly last_seen: number
}
export interface ChallengeHeader {
  readonly t: "challenge"
  readonly nonce: string
  readonly now: number
}
export interface ReadyHeader {
  readonly t: "ready"
  readonly peers: readonly Peer[]
}
/** A pairing phone waits here until the Mac sends add_device (then `ready`). */
export interface PairPendingHeader {
  readonly t: "pair_pending"
}
export interface MsgInHeader {
  readonly t: "msg"
  readonly from: string
  readonly id: string
}
export interface QueuedInHeader {
  readonly t: "queued"
  readonly id: string
  readonly from: string
}
export interface StoredHeader {
  readonly t: "stored"
  readonly id: string
}
export type UndeliverableReason = "offline" | "unknown_peer" | "queue_full"
export interface UndeliverableHeader {
  readonly t: "undeliverable"
  readonly id: string
  readonly reason: UndeliverableReason
}
export interface PresenceInHeader {
  readonly t: "presence"
  readonly dev: string
  readonly state: PresenceState
  readonly last_seen: number
}
export interface PairRequestHeader {
  readonly t: "pair_request"
  readonly dev: string
  readonly ed_pub: string
  readonly x_pub: string
  readonly name: string
}
/** The pairing phone left before the Mac decided: it cancelled, dropped or timed out. */
export interface PairGoneHeader {
  readonly t: "pair_gone"
  readonly dev: string
}
export interface PairOfferedHeader {
  readonly t: "pair_offered"
  readonly token_hash: string
}
export interface DeviceAddedHeader {
  readonly t: "device_added"
  readonly dev: string
}
export interface DeviceRemovedHeader {
  readonly t: "device_removed"
  readonly dev: string
}
/** To the leaving phone: the relay holds the leave for the Mac. */
export interface LeftHeader {
  readonly t: "left"
}
/**
 * To the Mac, on `ready` and while connected: this phone unpaired. `sig` is the
 * phone's own signature (see LeaveHeader); the Mac checks it against the key it
 * paired, so the relay cannot make one up. Repeated until the Mac sends
 * remove_device for `dev`.
 */
export interface DeviceLeftHeader {
  readonly t: "device_left"
  readonly dev: string
  readonly sig: string
}
/**
 * "accepted": Apple took it. "rejected": Apple refused it with `reason`
 * (`Unregistered`, `BadDeviceToken`: drop the token). "unavailable": no APNs
 * sender here, or Apple or the network failed; a later retry may work.
 */
export type PushedHeader =
  | { readonly t: "pushed"; readonly id: string; readonly status: "accepted" }
  | {
      readonly t: "pushed"
      readonly id: string
      readonly status: "rejected" | "unavailable"
      readonly reason: string
    }
export type RelayErrorCode =
  | "bad_frame"
  | "auth_failed"
  | "unknown_device"
  | "forbidden"
  | "bad_signature"
  | "mac_offline"
  | "limit"
export interface ErrorHeader {
  readonly t: "error"
  readonly code: RelayErrorCode
  readonly message: string
}

export type RelayHeader =
  | ChallengeHeader
  | ReadyHeader
  | PairPendingHeader
  | MsgInHeader
  | QueuedInHeader
  | StoredHeader
  | UndeliverableHeader
  | PresenceInHeader
  | PairRequestHeader
  | PairGoneHeader
  | PairOfferedHeader
  | DeviceAddedHeader
  | DeviceRemovedHeader
  | LeftHeader
  | DeviceLeftHeader
  | PushedHeader
  | ErrorHeader

/** WebSocket close codes the relay uses. */
export const CloseCode = {
  Protocol: 4000,
  AuthFailed: 4001,
  Revoked: 4003,
  Replaced: 4004,
  /** The Mac said no to a pairing phone. */
  Denied: 4005,
  /** The phone unpaired itself. */
  Left: 4006,
  Timeout: 4008,
  TooBig: 1009
} as const

export const parseClientHeader = (header: unknown): ClientHeader | undefined => {
  if (!isRecord(header)) return undefined
  const r = reader(header)
  switch (header["t"]) {
    case "auth": {
      const role = r.oneOf("role", ["mac", "phone"] as const)
      const base = {
        t: "auth" as const,
        mac: r.dev("mac"),
        dev: r.dev("dev"),
        role,
        sig: r.sig("sig")
      }
      const ed_pub = r.optional("ed_pub", r.key)
      const x_pub = r.optional("x_pub", r.key)
      const name = r.optional("name", r.name)
      const pair_token = r.optional("pair_token", r.key)
      return r.done({
        ...base,
        ...(ed_pub === undefined ? {} : { ed_pub }),
        ...(x_pub === undefined ? {} : { x_pub }),
        ...(name === undefined ? {} : { name }),
        ...(pair_token === undefined ? {} : { pair_token })
      })
    }
    case "msg":
      return r.done({ t: "msg", to: r.dev("to"), id: r.id("id") })
    case "queued":
      return r.done({ t: "queued", id: r.id("id") })
    case "qack":
      return r.done({ t: "qack", id: r.id("id") })
    case "presence":
      return r.done({ t: "presence", state: r.oneOf("state", ["online", "asleep"] as const) })
    case "add_device":
      return r.done({
        t: "add_device",
        dev: r.dev("dev"),
        ed_pub: r.key("ed_pub"),
        name: r.name("name"),
        sig_mac: r.sig("sig_mac")
      })
    case "remove_device":
      return r.done({ t: "remove_device", dev: r.dev("dev"), sig_mac: r.sig("sig_mac") })
    case "leave":
      return r.done({ t: "leave", sig: r.sig("sig") })
    case "pair_offer":
      return r.done({
        t: "pair_offer",
        token_hash: r.key("token_hash"),
        expires: r.number("expires")
      })
    case "pair_deny":
      return r.done({ t: "pair_deny", dev: r.dev("dev") })
    case "push": {
      const base = {
        t: "push" as const,
        id: r.id("id"),
        dev: r.dev("dev"),
        token: r.matching(apnsTokenPattern)("token"),
        env: r.oneOf("env", ["sandbox", "production"] as const),
        topic: r.matching(topicPattern)("topic"),
        collapse_id: r.id("collapse_id"),
        priority: r.oneOf("priority", ["high", "normal"] as const)
      }
      const category = r.optional("category", r.matching(categoryPattern))
      return r.done(category === undefined ? base : { ...base, category })
    }
    default:
      return undefined
  }
}

export const parseRelayHeader = (header: unknown): RelayHeader | undefined => {
  if (!isRecord(header)) return undefined
  const r = reader(header)
  switch (header["t"]) {
    case "challenge":
      return r.done({ t: "challenge", nonce: r.key("nonce"), now: r.number("now") })
    case "ready":
      return r.done({ t: "ready", peers: r.peers("peers") })
    case "pair_pending":
      return r.done({ t: "pair_pending" })
    case "msg":
      return r.done({ t: "msg", from: r.dev("from"), id: r.id("id") })
    case "queued":
      return r.done({ t: "queued", id: r.id("id"), from: r.dev("from") })
    case "stored":
      return r.done({ t: "stored", id: r.id("id") })
    case "undeliverable":
      return r.done({
        t: "undeliverable",
        id: r.id("id"),
        reason: r.oneOf("reason", ["offline", "unknown_peer", "queue_full"] as const)
      })
    case "presence":
      return r.done({
        t: "presence",
        dev: r.dev("dev"),
        state: r.oneOf("state", ["online", "asleep", "offline"] as const),
        last_seen: r.number("last_seen")
      })
    case "pair_request":
      return r.done({
        t: "pair_request",
        dev: r.dev("dev"),
        ed_pub: r.key("ed_pub"),
        x_pub: r.key("x_pub"),
        name: r.name("name")
      })
    case "pair_gone":
      return r.done({ t: "pair_gone", dev: r.dev("dev") })
    case "pair_offered":
      return r.done({ t: "pair_offered", token_hash: r.key("token_hash") })
    case "device_added":
      return r.done({ t: "device_added", dev: r.dev("dev") })
    case "device_removed":
      return r.done({ t: "device_removed", dev: r.dev("dev") })
    case "left":
      return r.done({ t: "left" })
    case "device_left":
      return r.done({ t: "device_left", dev: r.dev("dev"), sig: r.sig("sig") })
    case "pushed": {
      const id = r.id("id")
      const status = r.oneOf("status", ["accepted", "rejected", "unavailable"] as const)
      if (status === "accepted") return r.done({ t: "pushed", id, status })
      return r.done({ t: "pushed", id, status, reason: r.string("reason") })
    }
    case "error":
      return r.done({
        t: "error",
        code: r.oneOf("code", [
          "bad_frame",
          "auth_failed",
          "unknown_device",
          "forbidden",
          "bad_signature",
          "mac_offline",
          "limit"
        ] as const),
        message: r.string("message")
      })
    default:
      return undefined
  }
}

const reader = (record: Record<string, unknown>) => {
  let valid = true
  const fail = <T>(fallback: T): T => {
    valid = false
    return fallback
  }
  const string = (field: string): string => {
    const value = record[field]
    return typeof value === "string" ? value : fail("")
  }
  const matching =
    (pattern: RegExp) =>
    (field: string): string => {
      const value = string(field)
      return pattern.test(value) ? value : fail("")
    }
  const name = (field: string): string => {
    const value = string(field)
    return value.length >= 1 && value.length <= 64 ? value : fail("")
  }
  const number = (field: string): number => {
    const value = record[field]
    return typeof value === "number" && Number.isFinite(value) ? value : fail(0)
  }
  const oneOf = <const T extends readonly string[]>(field: string, values: T): T[number] => {
    const value = record[field]
    const found = values.find((candidate) => candidate === value)
    return found ?? fail(values[0] ?? "")
  }
  const peers = (field: string): Peer[] => {
    const value = record[field]
    if (!Array.isArray(value)) return fail([])
    return value.flatMap((item: unknown): Peer[] => {
      if (!isRecord(item)) return fail([])
      const p = reader(item)
      const peer = p.done({
        dev: p.dev("dev"),
        role: p.oneOf("role", ["mac", "phone"] as const),
        name: p.string("name"),
        online: typeof item["online"] === "boolean" ? item["online"] : p.fail(false),
        state: p.oneOf("state", ["online", "asleep", "offline"] as const),
        last_seen: p.number("last_seen")
      })
      return peer === undefined ? fail([]) : [peer]
    })
  }
  return {
    fail,
    string,
    name,
    number,
    oneOf,
    peers,
    matching,
    dev: matching(devPattern),
    id: matching(idPattern),
    key: matching(key32Pattern),
    sig: matching(sig64Pattern),
    optional: <T>(field: string, read: (field: string) => T): T | undefined =>
      record[field] === undefined ? undefined : read(field),
    done: <T>(value: T): T | undefined => (valid ? value : undefined)
  }
}
