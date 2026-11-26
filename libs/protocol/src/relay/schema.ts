import { Effect, Schema } from "effect"
import { strict } from "../common/boundary.js"
import { IsoDateTimeStringSchema, NonNegativeIntSchema } from "../common/schema.js"

export const RELAY_PRESENCE = { online: "online", offline: "offline", unseen: "unseen" } as const
export const RELAY_PAIR_REQUEST = { none: "none", waiting: "waiting" } as const
export const RELAY_CONNECTION = {
  off: "off",
  unavailable: "unavailable",
  idle: "idle",
  connecting: "connecting",
  connected: "connected"
} as const
export const RELAY_SETTING = {
  enabled: "enabled",
  relay_url: "relay_url",
  keep_awake: "keep_awake"
} as const

const Dev = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/))

export const RelayDeviceSchema = Schema.Struct({
  dev: Dev,
  name: Schema.String,
  added_at: IsoDateTimeStringSchema,
  presence: Schema.Union([
    Schema.Struct({ state: Schema.Literal(RELAY_PRESENCE.online) }),
    Schema.Struct({
      state: Schema.Literal(RELAY_PRESENCE.offline),
      last_seen_at: IsoDateTimeStringSchema
    }),
    Schema.Struct({ state: Schema.Literal(RELAY_PRESENCE.unseen) })
  ])
})

export const RelayPairRequestSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RELAY_PAIR_REQUEST.none) }),
  Schema.Struct({
    kind: Schema.Literal(RELAY_PAIR_REQUEST.waiting),
    dev: Dev,
    name: Schema.String,
    code: Schema.String.check(Schema.isPattern(/^\d{6}$/))
  })
])

export const RelayConnectionSchema = Schema.Literals(Object.values(RELAY_CONNECTION))

export const RelayStatusSchema = Schema.Struct({
  connection: RelayConnectionSchema,
  enabled: Schema.Boolean,
  relay_url: Schema.String,
  keep_awake: Schema.Boolean,
  keeping_awake: NonNegativeIntSchema,
  pair_request: RelayPairRequestSchema,
  devices: Schema.Array(RelayDeviceSchema)
})

export const RelayPairOfferSchema = Schema.Struct({
  link: Schema.String,
  expires_at: IsoDateTimeStringSchema
})

export const RelayPairDecisionSchema = Schema.Struct({
  dev: Dev,
  allow: Schema.Boolean
})

export const RelaySettingsPatchSchema = Schema.Union([
  Schema.Struct({ setting: Schema.Literal(RELAY_SETTING.enabled), enabled: Schema.Boolean }),
  Schema.Struct({
    setting: Schema.Literal(RELAY_SETTING.relay_url),
    relay_url: Schema.String.check(Schema.isPattern(/^wss?:\/\/\S+$/))
  }),
  Schema.Struct({ setting: Schema.Literal(RELAY_SETTING.keep_awake), keep_awake: Schema.Boolean })
])

export const encodeRelayPairDecisionEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(RelayPairDecisionSchema))(value, strict)

export const encodeRelaySettingsPatchEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(RelaySettingsPatchSchema)(value, strict).pipe(
    Effect.map((patch) => JSON.stringify(patch))
  )
