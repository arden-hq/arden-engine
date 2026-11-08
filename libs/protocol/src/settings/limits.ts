import { Effect, Schema } from "effect"
import type { JsonRecord } from "../common/json.js"
import { IsoDateTimeStringSchema, withExtras } from "../common/schema.js"

/** One Automation's own limits; each null means none. */
export interface AutomationLimit extends JsonRecord {
  /** Pauses at this, never above the background limit. */
  readonly pauseAtPercent: number | null
  /** A run that uses this many tokens stops; the next occurrence starts fresh. */
  readonly maxTokensPerRun: number | null
}

/**
 * How much of a plan Arden may use. A limit is a percentage of each plan
 * window; the lower one never applies above the higher one.
 */
export interface LimitSettings extends JsonRecord {
  /** Nothing in Arden uses the plan past this; null means Arden never stops on its own. */
  readonly ardenLimitPercent: number | null
  /** Automations, Space workers and maintenance pause past this; null adds no background stop. */
  readonly backgroundLimitPercent: number | null
  /** Chats may go past the Arden limit until this time; null means they stop at it. */
  readonly keepGoingUntil: string | null
  /** An Automation's own limits, by Automation id. Absent means it follows the background limit. */
  readonly automationLimits: Readonly<Record<string, AutomationLimit>>
}

/** A change to the settings. `automationLimit` sets one Automation's limits;
 *  both null removes them. */
export type LimitSettingsPatch = Partial<Omit<LimitSettings, "automationLimits">> & {
  readonly automationLimit?: AutomationLimit & { readonly automationId: string }
}

export const DEFAULT_LIMIT_SETTINGS: LimitSettings = Object.freeze({
  ardenLimitPercent: 90,
  backgroundLimitPercent: 70,
  keepGoingUntil: null,
  automationLimits: {}
})

/** Background work still follows the Arden limit when its own stop is Never. */
export const effectiveBackgroundLimit = (settings: LimitSettings): number | null => {
  if (settings.ardenLimitPercent === null) return settings.backgroundLimitPercent
  if (settings.backgroundLimitPercent === null) return settings.ardenLimitPercent
  return Math.min(settings.backgroundLimitPercent, settings.ardenLimitPercent)
}

const PercentSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(10),
  Schema.isLessThanOrEqualTo(100)
)
const TokensSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(10_000),
  Schema.isLessThanOrEqualTo(100_000_000)
)
const AutomationIdSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))

const AutomationLimitSchema = Schema.Struct({
  pauseAtPercent: Schema.NullOr(PercentSchema),
  maxTokensPerRun: Schema.NullOr(TokensSchema)
})

const AutomationLimitWireSchema = Schema.Struct({
  pause_at_percent: Schema.NullOr(PercentSchema),
  max_tokens_per_run: Schema.NullOr(TokensSchema)
})

export const LimitSettingsSchema = Schema.Struct({
  ardenLimitPercent: Schema.NullOr(PercentSchema),
  backgroundLimitPercent: Schema.NullOr(PercentSchema),
  keepGoingUntil: Schema.NullOr(IsoDateTimeStringSchema),
  automationLimits: Schema.Record(Schema.String, AutomationLimitSchema)
})

/** What a stored document may change: the Automation map is replaced whole. */
export const LimitSettingsDocumentPatchSchema = Schema.Struct({
  ardenLimitPercent: Schema.optionalKey(Schema.NullOr(PercentSchema)),
  backgroundLimitPercent: Schema.optionalKey(Schema.NullOr(PercentSchema)),
  keepGoingUntil: Schema.optionalKey(Schema.NullOr(IsoDateTimeStringSchema)),
  automationLimits: Schema.optionalKey(Schema.Record(Schema.String, AutomationLimitSchema))
})

export const LimitSettingsResponseSchema = withExtras({
  arden_limit_percent: Schema.NullOr(PercentSchema),
  background_limit_percent: Schema.NullOr(PercentSchema),
  keep_going_until: Schema.NullOr(IsoDateTimeStringSchema),
  automation_limits: Schema.Record(Schema.String, AutomationLimitWireSchema)
})

const atLeastOne = Schema.makeFilter((patch: object) =>
  Object.keys(patch).length > 0 ? undefined : "a limits patch requires at least one field"
)

export const LimitSettingsPatchSchema = Schema.Struct({
  ardenLimitPercent: Schema.optionalKey(Schema.NullOr(PercentSchema)),
  backgroundLimitPercent: Schema.optionalKey(Schema.NullOr(PercentSchema)),
  keepGoingUntil: Schema.optionalKey(Schema.NullOr(IsoDateTimeStringSchema)),
  automationLimit: Schema.optionalKey(
    Schema.Struct({ automationId: AutomationIdSchema, ...AutomationLimitSchema.fields })
  )
}).check(atLeastOne)

export const LimitSettingsPatchRequestSchema = Schema.Struct({
  arden_limit_percent: Schema.optionalKey(Schema.NullOr(PercentSchema)),
  background_limit_percent: Schema.optionalKey(Schema.NullOr(PercentSchema)),
  keep_going_until: Schema.optionalKey(Schema.NullOr(IsoDateTimeStringSchema)),
  automation_limit: Schema.optionalKey(
    Schema.Struct({ automation_id: AutomationIdSchema, ...AutomationLimitWireSchema.fields })
  )
}).check(atLeastOne)

type LimitSettingsWire = Schema.Schema.Type<typeof LimitSettingsResponseSchema>

const mapRecord = <A, B>(
  record: Readonly<Record<string, A>>,
  map: (value: A) => B
): Record<string, B> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))

export const mapLimitSettings = (wire: LimitSettingsWire): LimitSettings => ({
  ardenLimitPercent: wire.arden_limit_percent,
  backgroundLimitPercent: wire.background_limit_percent,
  keepGoingUntil: wire.keep_going_until,
  automationLimits: mapRecord(wire.automation_limits, (limit) => ({
    pauseAtPercent: limit.pause_at_percent,
    maxTokensPerRun: limit.max_tokens_per_run
  }))
})

export const limitSettingsResponse = (settings: LimitSettings): LimitSettingsWire => ({
  arden_limit_percent: settings.ardenLimitPercent,
  background_limit_percent: settings.backgroundLimitPercent,
  keep_going_until: settings.keepGoingUntil,
  automation_limits: mapRecord(settings.automationLimits, (limit) => ({
    pause_at_percent: limit.pauseAtPercent,
    max_tokens_per_run: limit.maxTokensPerRun
  }))
})

const strict = { onExcessProperty: "error" } as const

export const decodeLimitSettingsPatchRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(LimitSettingsPatchRequestSchema)(value, strict).pipe(
    Effect.map((patch): LimitSettingsPatch => ({
      ...(patch.arden_limit_percent === undefined
        ? {}
        : { ardenLimitPercent: patch.arden_limit_percent }),
      ...(patch.background_limit_percent === undefined
        ? {}
        : { backgroundLimitPercent: patch.background_limit_percent }),
      ...(patch.keep_going_until === undefined ? {} : { keepGoingUntil: patch.keep_going_until }),
      ...(patch.automation_limit === undefined
        ? {}
        : {
            automationLimit: {
              automationId: patch.automation_limit.automation_id,
              pauseAtPercent: patch.automation_limit.pause_at_percent,
              maxTokensPerRun: patch.automation_limit.max_tokens_per_run
            }
          })
    }))
  )

export const encodeLimitSettingsPatchEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(LimitSettingsPatchSchema)(value, strict).pipe(
    Effect.map((patch) =>
      JSON.stringify({
        ...(patch.ardenLimitPercent === undefined
          ? {}
          : { arden_limit_percent: patch.ardenLimitPercent }),
        ...(patch.backgroundLimitPercent === undefined
          ? {}
          : { background_limit_percent: patch.backgroundLimitPercent }),
        ...(patch.keepGoingUntil === undefined ? {} : { keep_going_until: patch.keepGoingUntil }),
        ...(patch.automationLimit === undefined
          ? {}
          : {
              automation_limit: {
                automation_id: patch.automationLimit.automationId,
                pause_at_percent: patch.automationLimit.pauseAtPercent,
                max_tokens_per_run: patch.automationLimit.maxTokensPerRun
              }
            })
      })
    )
  )
