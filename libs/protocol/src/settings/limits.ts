import { Effect, Schema, type SchemaAST } from "effect"
import type { JsonRecord } from "../common/json.js"
import { IsoDateTimeStringSchema, withExtras } from "../common/schema.js"

export const PLAN_STOP = { unlimited: "unlimited", at: "at" } as const

export type PlanStop =
  | { readonly kind: "unlimited" }
  | { readonly kind: "at"; readonly percent: number }

export const TOKEN_CAP = { uncapped: "uncapped", capped: "capped" } as const

export type TokenCap =
  | { readonly kind: "uncapped" }
  | { readonly kind: "capped"; readonly tokens: number }

export const KEEP_GOING = { off: "off", until: "until" } as const

export type KeepGoing =
  | { readonly kind: "off" }
  | { readonly kind: "until"; readonly until: string }

export interface AutomationLimit extends JsonRecord {
  readonly pause: PlanStop
  readonly cap: TokenCap
}

export interface LimitSettings extends JsonRecord {
  readonly ardenLimit: PlanStop
  readonly backgroundLimit: PlanStop
  readonly keepGoing: KeepGoing
  readonly automationLimits: Readonly<Record<string, AutomationLimit>>
}

export const LIMIT_SETTINGS_CHANGE = {
  ardenLimit: "arden_limit",
  backgroundLimit: "background_limit",
  keepGoing: "keep_going",
  automationLimit: "automation_limit"
} as const

export type LimitSettingsChange =
  | { readonly kind: "arden_limit"; readonly value: PlanStop }
  | { readonly kind: "background_limit"; readonly value: PlanStop }
  | { readonly kind: "keep_going"; readonly value: KeepGoing }
  | {
      readonly kind: "automation_limit"
      readonly automation: string
      readonly value: AutomationLimit
    }

export type LimitSettingsPatch = ReadonlyArray<LimitSettingsChange>

export const DEFAULT_LIMIT_SETTINGS: LimitSettings = Object.freeze({
  ardenLimit: { kind: PLAN_STOP.at, percent: 90 },
  backgroundLimit: { kind: PLAN_STOP.at, percent: 70 },
  keepGoing: { kind: KEEP_GOING.off },
  automationLimits: {}
})

export const effectiveBackgroundLimit = (settings: LimitSettings): PlanStop => {
  const { ardenLimit, backgroundLimit } = settings
  if (ardenLimit.kind === PLAN_STOP.unlimited) return backgroundLimit
  if (backgroundLimit.kind === PLAN_STOP.unlimited) return ardenLimit
  return backgroundLimit.percent <= ardenLimit.percent ? backgroundLimit : ardenLimit
}

const isUnlimited = (limit: AutomationLimit): boolean =>
  limit.pause.kind === PLAN_STOP.unlimited && limit.cap.kind === TOKEN_CAP.uncapped

const applyLimitChange = (settings: LimitSettings, change: LimitSettingsChange): LimitSettings => {
  switch (change.kind) {
    case LIMIT_SETTINGS_CHANGE.ardenLimit:
      return { ...settings, ardenLimit: change.value }
    case LIMIT_SETTINGS_CHANGE.backgroundLimit:
      return { ...settings, backgroundLimit: change.value }
    case LIMIT_SETTINGS_CHANGE.keepGoing:
      return { ...settings, keepGoing: change.value }
    case LIMIT_SETTINGS_CHANGE.automationLimit: {
      const { [change.automation]: _previous, ...others } = settings.automationLimits
      return {
        ...settings,
        automationLimits: isUnlimited(change.value)
          ? others
          : { ...others, [change.automation]: change.value }
      }
    }
  }
}

export const applyLimitSettingsPatch = (
  settings: LimitSettings,
  patch: LimitSettingsPatch
): LimitSettings => patch.reduce(applyLimitChange, settings)

const PercentSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(10),
  Schema.isLessThanOrEqualTo(100)
)
const TokensSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(10_000),
  Schema.isLessThanOrEqualTo(100_000_000)
)
const AutomationIdSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))

const PlanStopSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(PLAN_STOP.unlimited) }),
  Schema.Struct({ kind: Schema.Literal(PLAN_STOP.at), percent: PercentSchema })
])

const TokenCapSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(TOKEN_CAP.uncapped) }),
  Schema.Struct({ kind: Schema.Literal(TOKEN_CAP.capped), tokens: TokensSchema })
])

const KeepGoingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(KEEP_GOING.off) }),
  Schema.Struct({ kind: Schema.Literal(KEEP_GOING.until), until: IsoDateTimeStringSchema })
])

const AutomationLimitSchema = Schema.Struct({ pause: PlanStopSchema, cap: TokenCapSchema })

export const LimitSettingsSchema = Schema.Struct({
  ardenLimit: PlanStopSchema,
  backgroundLimit: PlanStopSchema,
  keepGoing: KeepGoingSchema,
  automationLimits: Schema.Record(Schema.String, AutomationLimitSchema)
})

export const LimitSettingsResponseSchema = withExtras({
  arden_limit: PlanStopSchema,
  background_limit: PlanStopSchema,
  keep_going: KeepGoingSchema,
  automation_limits: Schema.Record(Schema.String, AutomationLimitSchema)
})

const LimitSettingsChangeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(LIMIT_SETTINGS_CHANGE.ardenLimit), value: PlanStopSchema }),
  Schema.Struct({
    kind: Schema.Literal(LIMIT_SETTINGS_CHANGE.backgroundLimit),
    value: PlanStopSchema
  }),
  Schema.Struct({ kind: Schema.Literal(LIMIT_SETTINGS_CHANGE.keepGoing), value: KeepGoingSchema }),
  Schema.Struct({
    kind: Schema.Literal(LIMIT_SETTINGS_CHANGE.automationLimit),
    automation: AutomationIdSchema,
    value: AutomationLimitSchema
  })
])

export const LimitSettingsPatchRequestSchema = Schema.Struct({
  changes: Schema.NonEmptyArray(LimitSettingsChangeSchema)
})

type LimitSettingsWire = Schema.Schema.Type<typeof LimitSettingsResponseSchema>

export const mapLimitSettings = (wire: LimitSettingsWire): LimitSettings => ({
  ardenLimit: wire.arden_limit,
  backgroundLimit: wire.background_limit,
  keepGoing: wire.keep_going,
  automationLimits: wire.automation_limits
})

export const limitSettingsResponse = (settings: LimitSettings): LimitSettingsWire => ({
  arden_limit: settings.ardenLimit,
  background_limit: settings.backgroundLimit,
  keep_going: settings.keepGoing,
  automation_limits: settings.automationLimits
})

const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }

export const decodeLimitSettingsPatchRequestEffect = (
  value: unknown
): Effect.Effect<LimitSettingsPatch, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(LimitSettingsPatchRequestSchema)(value, strict).pipe(
    Effect.map((patch) => patch.changes)
  )

export const encodeLimitSettingsPatchEffect = (
  value: LimitSettingsPatch
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(LimitSettingsPatchRequestSchema)({ changes: value }, strict).pipe(
    Effect.map(JSON.stringify)
  )
