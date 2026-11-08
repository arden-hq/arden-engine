import { makeEncoder, projectedDecoderFor } from "../common/boundary.js"
import type { IntelligenceSettingsPatch } from "./contracts.js"
import {
  IntelligenceSettingsResponseSchema,
  mapSettings,
  encodeIntelligenceSettingsPatchEffect
} from "./schema.js"
import {
  LimitSettingsResponseSchema,
  mapLimitSettings,
  encodeLimitSettingsPatchEffect,
  type LimitSettingsPatch
} from "./limits.js"

export * from "./contracts.js"

export const intelligenceSettingsDecoders = {
  settings: projectedDecoderFor(
    IntelligenceSettingsResponseSchema,
    mapSettings,
    "Invalid intelligence settings"
  )
} as const

export const intelligenceSettingsRequests = {
  update: makeEncoder<IntelligenceSettingsPatch>(
    encodeIntelligenceSettingsPatchEffect,
    "Invalid intelligence settings patch"
  )
} as const

export const intelligenceSettingsRoutes = {
  settings: "/settings/intelligence"
} as const

export { DEFAULT_LIMIT_SETTINGS, effectiveBackgroundLimit } from "./limits.js"
export type { AutomationLimit, LimitSettings, LimitSettingsPatch } from "./limits.js"

export const limitSettingsDecoders = {
  settings: projectedDecoderFor(
    LimitSettingsResponseSchema,
    mapLimitSettings,
    "Invalid limit settings"
  )
} as const

export const limitSettingsRequests = {
  update: makeEncoder<LimitSettingsPatch>(
    encodeLimitSettingsPatchEffect,
    "Invalid limit settings patch"
  )
} as const

export const limitSettingsRoutes = {
  settings: "/settings/limits"
} as const
