import { decoderFor, makeEncoder } from "../common/boundary.js"
import {
  encodeRelayPairDecisionEffect,
  encodeRelaySettingsPatchEffect,
  RelayPairOfferSchema,
  RelayStatusSchema,
  type RelayPairDecisionSchema,
  type RelaySettingsPatchSchema
} from "./schema.js"

export type RelayStatus = typeof RelayStatusSchema.Type
export type RelayDevice = RelayStatus["devices"][number]
export type RelayPairRequest = NonNullable<RelayStatus["pair_request"]>
export type RelayConnection = RelayStatus["connection"]
export type RelayPairOffer = typeof RelayPairOfferSchema.Type
export type RelayPairDecision = typeof RelayPairDecisionSchema.Type
export type RelaySettingsPatch = typeof RelaySettingsPatchSchema.Type

export const relayDecoders = {
  status: decoderFor(RelayStatusSchema, "Invalid iPhone status"),
  offer: decoderFor(RelayPairOfferSchema, "Invalid pairing code")
} as const

export const relayRequests = {
  decision: makeEncoder<RelayPairDecision>(
    encodeRelayPairDecisionEffect,
    "Invalid pairing decision"
  ),
  settings: makeEncoder<RelaySettingsPatch>(
    encodeRelaySettingsPatchEffect,
    "Invalid iPhone settings"
  )
} as const

export const relayRoutes = {
  status: "/relay",
  pair: "/relay/pair",
  decision: "/relay/pair/decision",
  settings: "/relay/settings",
  device: (dev: string): string => `/relay/devices/${encodeURIComponent(dev)}`
} as const
