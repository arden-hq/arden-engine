import { Effect, Schema } from "effect"
import { strict } from "../common/boundary.js"
import { IsoDateTimeStringSchema, NonNegativeIntSchema } from "../common/schema.js"

/**
 * The Mac's side of the iPhone companion, for Settings: the relay connection,
 * pairing, and the paired phones. Absence is `null`.
 */

const Dev = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/))

export const RelayDeviceSchema = Schema.Struct({
  dev: Dev,
  name: Schema.String,
  added_at: IsoDateTimeStringSchema,
  /** While `online` this is now. */
  last_seen_at: Schema.NullOr(IsoDateTimeStringSchema),
  online: Schema.Boolean
})

/** A phone that scanned the code and waits for this Mac to allow it. Both
 *  screens show `code`. */
export const RelayPairRequestSchema = Schema.Struct({
  dev: Dev,
  name: Schema.String,
  code: Schema.String.check(Schema.isPattern(/^\d{6}$/))
})

/**
 * `off` — turned off in settings; `unavailable` — this Mac has no secure
 * storage for its keys (no desktop host); `idle` — on, but nothing needs the
 * relay yet (no phone paired, no pairing open); `connecting`, `connected`.
 */
export const RelayConnectionSchema = Schema.Literals([
  "off",
  "unavailable",
  "idle",
  "connecting",
  "connected"
])

export const RelayStatusSchema = Schema.Struct({
  connection: RelayConnectionSchema,
  enabled: Schema.Boolean,
  relay_url: Schema.String,
  keep_awake: Schema.Boolean,
  /** Runs the Mac is kept awake for now; 0 when it is not held awake. */
  keeping_awake: NonNegativeIntSchema,
  pair_request: Schema.NullOr(RelayPairRequestSchema),
  devices: Schema.Array(RelayDeviceSchema)
})

/** What the pairing QR code encodes, and when it stops working. */
export const RelayPairOfferSchema = Schema.Struct({
  link: Schema.String,
  expires_at: IsoDateTimeStringSchema
})

export const RelayPairDecisionSchema = Schema.Struct({
  dev: Dev,
  allow: Schema.Boolean
})

export const RelaySettingsPatchSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  relay_url: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^wss?:\/\/\S+$/))),
  keep_awake: Schema.optionalKey(Schema.Boolean)
})

export const encodeRelayPairDecisionEffect = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(RelayPairDecisionSchema))(value, strict)

export const encodeRelaySettingsPatchEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(RelaySettingsPatchSchema)(value, strict).pipe(
    Effect.map((patch) => JSON.stringify(patch))
  )
