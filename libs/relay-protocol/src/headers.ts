import { isRecord } from "@arden-hq/std/json"

export const ROLE = { mac: "mac", phone: "phone" } as const
export type Role = (typeof ROLE)[keyof typeof ROLE]
const roles: ReadonlySet<unknown> = new Set(Object.values(ROLE))
export const isRole = (value: unknown): value is Role => roles.has(value)

export const PRESENCE_STATE = { online: "online", asleep: "asleep", offline: "offline" } as const
export type PresenceState = (typeof PRESENCE_STATE)[keyof typeof PRESENCE_STATE]
const presenceStates: ReadonlySet<unknown> = new Set(Object.values(PRESENCE_STATE))
export const isPresenceState = (value: unknown): value is PresenceState => presenceStates.has(value)
export const AWAKE_STATE = { online: PRESENCE_STATE.online, asleep: PRESENCE_STATE.asleep } as const
export type AwakeState = (typeof AWAKE_STATE)[keyof typeof AWAKE_STATE]

export const HEADER_TAG = {
  auth: "auth",
  msg: "msg",
  queued: "queued",
  qack: "qack",
  presence: "presence",
  add_device: "add_device",
  remove_device: "remove_device",
  leave: "leave",
  pair_deny: "pair_deny",
  pair_offer: "pair_offer",
  push: "push",
  challenge: "challenge",
  ready: "ready",
  pair_pending: "pair_pending",
  stored: "stored",
  undeliverable: "undeliverable",
  pair_request: "pair_request",
  pair_gone: "pair_gone",
  pair_offered: "pair_offered",
  device_added: "device_added",
  device_removed: "device_removed",
  left: "left",
  device_left: "device_left",
  pushed: "pushed",
  error: "error"
} as const
export type HeaderTag = (typeof HEADER_TAG)[keyof typeof HEADER_TAG]

const devPattern = /^[A-Za-z0-9_-]{22}$/
const idPattern = /^[A-Za-z0-9_-]{1,64}$/
const key32Pattern = /^[A-Za-z0-9_-]{43}$/
const sig64Pattern = /^[A-Za-z0-9_-]{86}$/
const apnsTokenPattern = /^[0-9a-fA-F]{64,200}$/
const topicPattern = /^[A-Za-z0-9.-]{1,128}$/
const categoryPattern = /^[A-Za-z0-9._-]{1,64}$/

export const isDeviceId = (value: unknown): value is string =>
  typeof value === "string" && devPattern.test(value)

export interface AuthHeader {
  readonly t: typeof HEADER_TAG.auth
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
  readonly t: typeof HEADER_TAG.msg
  readonly to: string
  readonly id: string
}
export interface QueuedOutHeader {
  readonly t: typeof HEADER_TAG.queued
  readonly id: string
}
export interface QackHeader {
  readonly t: typeof HEADER_TAG.qack
  readonly id: string
}
export interface PresenceOutHeader {
  readonly t: typeof HEADER_TAG.presence
  readonly state: AwakeState
}
export interface AddDeviceHeader {
  readonly t: typeof HEADER_TAG.add_device
  readonly dev: string
  readonly ed_pub: string
  readonly name: string
  readonly sig_mac: string
}
export interface RemoveDeviceHeader {
  readonly t: typeof HEADER_TAG.remove_device
  readonly dev: string
  readonly sig_mac: string
}
export interface LeaveHeader {
  readonly t: typeof HEADER_TAG.leave
  readonly sig: string
}
export interface PairDenyHeader {
  readonly t: typeof HEADER_TAG.pair_deny
  readonly dev: string
}
export interface PairOfferHeader {
  readonly t: typeof HEADER_TAG.pair_offer
  readonly token_hash: string
  readonly expires: number
}
export const APNS_ENVIRONMENT = { sandbox: "sandbox", production: "production" } as const
export type ApnsEnvironment = (typeof APNS_ENVIRONMENT)[keyof typeof APNS_ENVIRONMENT]
export const PUSH_PRIORITY = { high: "high", normal: "normal" } as const
export type PushPriority = (typeof PUSH_PRIORITY)[keyof typeof PUSH_PRIORITY]
export interface PushHeader {
  readonly t: typeof HEADER_TAG.push
  readonly id: string
  readonly dev: string
  readonly token: string
  readonly env: ApnsEnvironment
  readonly topic: string
  readonly collapse_id: string
  readonly category?: string
  readonly priority: PushPriority
}

// https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification
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
  readonly last_seen: number
}
export interface ChallengeHeader {
  readonly t: typeof HEADER_TAG.challenge
  readonly nonce: string
  readonly now: number
}
export interface ReadyHeader {
  readonly t: typeof HEADER_TAG.ready
  readonly peers: readonly Peer[]
}
export interface PairPendingHeader {
  readonly t: typeof HEADER_TAG.pair_pending
}
export interface MsgInHeader {
  readonly t: typeof HEADER_TAG.msg
  readonly from: string
  readonly id: string
}
export interface QueuedInHeader {
  readonly t: typeof HEADER_TAG.queued
  readonly id: string
  readonly from: string
}
export interface StoredHeader {
  readonly t: typeof HEADER_TAG.stored
  readonly id: string
}
export const UNDELIVERABLE_REASON = {
  offline: "offline",
  unknown_peer: "unknown_peer",
  queue_full: "queue_full"
} as const
export type UndeliverableReason = (typeof UNDELIVERABLE_REASON)[keyof typeof UNDELIVERABLE_REASON]
export interface UndeliverableHeader {
  readonly t: typeof HEADER_TAG.undeliverable
  readonly id: string
  readonly reason: UndeliverableReason
}
export interface PresenceInHeader {
  readonly t: typeof HEADER_TAG.presence
  readonly dev: string
  readonly state: PresenceState
  readonly last_seen: number
}
export interface PairRequestHeader {
  readonly t: typeof HEADER_TAG.pair_request
  readonly dev: string
  readonly ed_pub: string
  readonly x_pub: string
  readonly name: string
}
export interface PairGoneHeader {
  readonly t: typeof HEADER_TAG.pair_gone
  readonly dev: string
}
export interface PairOfferedHeader {
  readonly t: typeof HEADER_TAG.pair_offered
  readonly token_hash: string
}
export interface DeviceAddedHeader {
  readonly t: typeof HEADER_TAG.device_added
  readonly dev: string
}
export interface DeviceRemovedHeader {
  readonly t: typeof HEADER_TAG.device_removed
  readonly dev: string
}
export interface LeftHeader {
  readonly t: typeof HEADER_TAG.left
}
export interface DeviceLeftHeader {
  readonly t: typeof HEADER_TAG.device_left
  readonly dev: string
  readonly sig: string
}
export const PUSH_STATUS = {
  accepted: "accepted",
  rejected: "rejected",
  unavailable: "unavailable"
} as const
export type PushStatus = (typeof PUSH_STATUS)[keyof typeof PUSH_STATUS]
export type PushOutcome =
  | { readonly status: typeof PUSH_STATUS.accepted }
  | {
      readonly status: typeof PUSH_STATUS.rejected | typeof PUSH_STATUS.unavailable
      readonly reason: string
    }
export type PushedHeader = {
  readonly t: typeof HEADER_TAG.pushed
  readonly id: string
} & PushOutcome

// https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
export const APNS_REASON = {
  BadDeviceToken: "BadDeviceToken",
  ExpiredProviderToken: "ExpiredProviderToken",
  Unregistered: "Unregistered"
} as const
export type ApnsReason = (typeof APNS_REASON)[keyof typeof APNS_REASON]

export const RELAY_ERROR_CODE = {
  bad_frame: "bad_frame",
  auth_failed: "auth_failed",
  unknown_device: "unknown_device",
  forbidden: "forbidden",
  bad_signature: "bad_signature",
  mac_offline: "mac_offline",
  limit: "limit"
} as const
export type RelayErrorCode = (typeof RELAY_ERROR_CODE)[keyof typeof RELAY_ERROR_CODE]
export interface ErrorHeader {
  readonly t: typeof HEADER_TAG.error
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

export const CloseCode = {
  Protocol: 4000,
  AuthFailed: 4001,
  Revoked: 4003,
  Replaced: 4004,
  Denied: 4005,
  Left: 4006,
  Timeout: 4008,
  TooBig: 1009
} as const

export const parseClientHeader = (header: unknown): ClientHeader | undefined =>
  readRecord(header, (r): ClientHeader | undefined => {
    switch (r.tag) {
      case HEADER_TAG.auth: {
        const ed_pub = r.optional("ed_pub", r.key)
        const x_pub = r.optional("x_pub", r.key)
        const name = r.optional("name", r.name)
        const pair_token = r.optional("pair_token", r.key)
        return {
          t: HEADER_TAG.auth,
          mac: r.dev("mac"),
          dev: r.dev("dev"),
          role: r.oneOf("role", ROLE),
          sig: r.sig("sig"),
          ...(ed_pub === undefined ? {} : { ed_pub }),
          ...(x_pub === undefined ? {} : { x_pub }),
          ...(name === undefined ? {} : { name }),
          ...(pair_token === undefined ? {} : { pair_token })
        }
      }
      case HEADER_TAG.msg:
        return { t: HEADER_TAG.msg, to: r.dev("to"), id: r.id("id") }
      case HEADER_TAG.queued:
        return { t: HEADER_TAG.queued, id: r.id("id") }
      case HEADER_TAG.qack:
        return { t: HEADER_TAG.qack, id: r.id("id") }
      case HEADER_TAG.presence:
        return { t: HEADER_TAG.presence, state: r.oneOf("state", AWAKE_STATE) }
      case HEADER_TAG.add_device:
        return {
          t: HEADER_TAG.add_device,
          dev: r.dev("dev"),
          ed_pub: r.key("ed_pub"),
          name: r.name("name"),
          sig_mac: r.sig("sig_mac")
        }
      case HEADER_TAG.remove_device:
        return { t: HEADER_TAG.remove_device, dev: r.dev("dev"), sig_mac: r.sig("sig_mac") }
      case HEADER_TAG.leave:
        return { t: HEADER_TAG.leave, sig: r.sig("sig") }
      case HEADER_TAG.pair_offer:
        return {
          t: HEADER_TAG.pair_offer,
          token_hash: r.key("token_hash"),
          expires: r.number("expires")
        }
      case HEADER_TAG.pair_deny:
        return { t: HEADER_TAG.pair_deny, dev: r.dev("dev") }
      case HEADER_TAG.push: {
        const category = r.optional("category", r.matching(categoryPattern))
        return {
          t: HEADER_TAG.push,
          id: r.id("id"),
          dev: r.dev("dev"),
          token: r.matching(apnsTokenPattern)("token"),
          env: r.oneOf("env", APNS_ENVIRONMENT),
          topic: r.matching(topicPattern)("topic"),
          collapse_id: r.id("collapse_id"),
          priority: r.oneOf("priority", PUSH_PRIORITY),
          ...(category === undefined ? {} : { category })
        }
      }
      default:
        return undefined
    }
  })

export const parseRelayHeader = (header: unknown): RelayHeader | undefined =>
  readRecord(header, (r): RelayHeader | undefined => {
    switch (r.tag) {
      case HEADER_TAG.challenge:
        return { t: HEADER_TAG.challenge, nonce: r.key("nonce"), now: r.number("now") }
      case HEADER_TAG.ready:
        return { t: HEADER_TAG.ready, peers: r.list("peers", readPeer) }
      case HEADER_TAG.pair_pending:
        return { t: HEADER_TAG.pair_pending }
      case HEADER_TAG.msg:
        return { t: HEADER_TAG.msg, from: r.dev("from"), id: r.id("id") }
      case HEADER_TAG.queued:
        return { t: HEADER_TAG.queued, id: r.id("id"), from: r.dev("from") }
      case HEADER_TAG.stored:
        return { t: HEADER_TAG.stored, id: r.id("id") }
      case HEADER_TAG.undeliverable:
        return {
          t: HEADER_TAG.undeliverable,
          id: r.id("id"),
          reason: r.oneOf("reason", UNDELIVERABLE_REASON)
        }
      case HEADER_TAG.presence:
        return {
          t: HEADER_TAG.presence,
          dev: r.dev("dev"),
          state: r.oneOf("state", PRESENCE_STATE),
          last_seen: r.number("last_seen")
        }
      case HEADER_TAG.pair_request:
        return {
          t: HEADER_TAG.pair_request,
          dev: r.dev("dev"),
          ed_pub: r.key("ed_pub"),
          x_pub: r.key("x_pub"),
          name: r.name("name")
        }
      case HEADER_TAG.pair_gone:
        return { t: HEADER_TAG.pair_gone, dev: r.dev("dev") }
      case HEADER_TAG.pair_offered:
        return { t: HEADER_TAG.pair_offered, token_hash: r.key("token_hash") }
      case HEADER_TAG.device_added:
        return { t: HEADER_TAG.device_added, dev: r.dev("dev") }
      case HEADER_TAG.device_removed:
        return { t: HEADER_TAG.device_removed, dev: r.dev("dev") }
      case HEADER_TAG.left:
        return { t: HEADER_TAG.left }
      case HEADER_TAG.device_left:
        return { t: HEADER_TAG.device_left, dev: r.dev("dev"), sig: r.sig("sig") }
      case HEADER_TAG.pushed: {
        const id = r.id("id")
        const status = r.oneOf("status", PUSH_STATUS)
        return status === PUSH_STATUS.accepted
          ? { t: HEADER_TAG.pushed, id, status }
          : { t: HEADER_TAG.pushed, id, status, reason: r.string("reason") }
      }
      case HEADER_TAG.error:
        return {
          t: HEADER_TAG.error,
          code: r.oneOf("code", RELAY_ERROR_CODE),
          message: r.string("message")
        }
      default:
        return undefined
    }
  })

const readPeer = (item: Record<string, unknown>): Peer => {
  const r = reader(item)
  return {
    dev: r.dev("dev"),
    role: r.oneOf("role", ROLE),
    name: r.string("name"),
    online: r.boolean("online"),
    state: r.oneOf("state", PRESENCE_STATE),
    last_seen: r.number("last_seen")
  }
}

const invalid = Symbol("invalid header field")

const readRecord = <T>(
  value: unknown,
  read: (r: ReturnType<typeof reader>) => T
): T | undefined => {
  if (!isRecord(value)) return undefined
  try {
    return read(reader(value))
  } catch (error) {
    if (error === invalid) return undefined
    throw error
  }
}

const fail = (): never => {
  throw invalid
}

const reader = (record: Record<string, unknown>) => {
  const string = (field: string): string => {
    const value = record[field]
    return typeof value === "string" ? value : fail()
  }
  const matching =
    (pattern: RegExp) =>
    (field: string): string => {
      const value = string(field)
      return pattern.test(value) ? value : fail()
    }
  return {
    tag: record["t"],
    string,
    matching,
    name: (field: string): string => {
      const value = string(field)
      return value.length >= 1 && value.length <= 64 ? value : fail()
    },
    number: (field: string): number => {
      const value = record[field]
      return typeof value === "number" && Number.isFinite(value) ? value : fail()
    },
    boolean: (field: string): boolean => {
      const value = record[field]
      return typeof value === "boolean" ? value : fail()
    },
    oneOf: <V extends string>(field: string, table: Readonly<Record<string, V>>): V => {
      const value = record[field]
      return Object.values(table).find((candidate) => candidate === value) ?? fail()
    },
    list: <T>(field: string, read: (item: Record<string, unknown>) => T): T[] => {
      const value = record[field]
      if (!Array.isArray(value)) return fail()
      return value.map((item: unknown): T => (isRecord(item) ? read(item) : fail()))
    },
    dev: matching(devPattern),
    id: matching(idPattern),
    key: matching(key32Pattern),
    sig: matching(sig64Pattern),
    optional: <T>(field: string, read: (field: string) => T): T | undefined =>
      record[field] === undefined ? undefined : read(field)
  }
}
