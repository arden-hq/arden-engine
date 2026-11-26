import { Schema } from "effect"
import { AutomationRunOutcomeSchema } from "../automations/outcome.js"
import type { AutomationRunOutcome } from "../automations/outcome.js"
import { CONTEXT_SIZE, type ContextSize } from "../chat/events/run.js"
import type { JsonRecord } from "../common/json.js"
import type { AppDestination } from "../common/navigation.js"
import {
  AppDestinationSchema,
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  RuntimeRunStatusSchema,
  SessionTypeSchema,
  withExtras,
  ProviderCostSchema
} from "../common/schema.js"
import type { RuntimeRunStatus } from "../chat/runtime.js"
import { SessionNameSchema } from "../sessions/state-schema.js"
import type { SessionType } from "../sessions/contracts.js"
import type { SessionName } from "../sessions/states.js"
import { RUN_MODEL, RUN_REASONING } from "./run-states.js"
import type { ProviderCost, RunModel, RunReasoning, RunUsage } from "./contracts.js"
import { RunUsageSchema } from "./schema.js"
import { MODEL_CALL_KIND, USAGE_ORIGIN, type ModelCallKind, type UsageOrigin } from "./usage.js"

export type UsageSessionType = SessionType

export const USAGE_SPACE = { none: "none", space: "space", removed: "removed" } as const

export type UsageSpace =
  | { readonly kind: typeof USAGE_SPACE.none }
  | { readonly kind: typeof USAGE_SPACE.space; readonly space_id: string; readonly name: string }
  | { readonly kind: typeof USAGE_SPACE.removed; readonly space_id: string }

export const USAGE_CHAT = { none: "none", chat: "chat" } as const

export type UsageChat =
  | { readonly kind: typeof USAGE_CHAT.none }
  | { readonly kind: typeof USAGE_CHAT.chat; readonly session_type: UsageSessionType }

export interface UsageDailyCell extends JsonRecord {
  readonly day: string
  readonly space: UsageSpace
  readonly origin: UsageOrigin
  readonly chat: UsageChat
  readonly model: RunModel
  readonly kind: ModelCallKind
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly cost: ProviderCost
  readonly runs: number
}

export interface UsageTopSession extends JsonRecord {
  readonly session_id: string
  readonly name: SessionName
  readonly space: UsageSpace
  readonly session_type: UsageSessionType
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly cost: ProviderCost
  readonly runs: number
  readonly average_last_input: ContextSize
}

export const USAGE_LINK = { none: "none", linked: "linked" } as const

export type UsageAutomation =
  | { readonly kind: typeof USAGE_LINK.none }
  | { readonly kind: typeof USAGE_LINK.linked; readonly task_id: string }

export type UsageTask =
  | { readonly kind: typeof USAGE_LINK.none }
  | { readonly kind: typeof USAGE_LINK.linked; readonly item_id: string }

export type UsageRowSpace =
  | { readonly kind: typeof USAGE_LINK.none }
  | { readonly kind: typeof USAGE_LINK.linked; readonly space_id: string }

export type UsageHandler =
  | { readonly kind: typeof USAGE_LINK.none }
  | { readonly kind: typeof USAGE_LINK.linked; readonly handler: string }

export type UsageDestination =
  | { readonly kind: typeof USAGE_LINK.none }
  | { readonly kind: typeof USAGE_LINK.linked; readonly destination: AppDestination }

export type UsagePurpose =
  | "user_automation"
  | "space_review"
  | "task_execution"
  | "system"
  | "unrecorded"

export type UsageOutcome = AutomationRunOutcome | "unrecorded"

export interface UsageAutomationOutcome extends JsonRecord {
  readonly outcome: UsageOutcome
  readonly checks: number
  readonly runs: number
  readonly unaccounted_runs: number
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
}

export interface UsageAutomationRow extends JsonRecord {
  readonly automation: UsageAutomation
  readonly task: UsageTask
  readonly space: UsageRowSpace
  readonly name: string
  readonly destination: UsageDestination
  readonly purpose: UsagePurpose
  readonly handler: UsageHandler
  readonly checks: number
  readonly runs: number
  readonly unaccounted_runs: number
  readonly total: number
  readonly cache_read: number
  readonly outcomes: ReadonlyArray<UsageAutomationOutcome>
}

export interface UsageReport extends JsonRecord {
  readonly days: number
  readonly since: string
  readonly daily: ReadonlyArray<UsageDailyCell>
  readonly top_sessions: ReadonlyArray<UsageTopSession>
  readonly automations: ReadonlyArray<UsageAutomationRow>
}

export const CALL_METER = { awaiting: "awaiting", metered: "metered" } as const

export type RunCallMeter =
  | { readonly kind: typeof CALL_METER.awaiting }
  | { readonly kind: typeof CALL_METER.metered; readonly usage: RunUsage }

export const STAMP = { unrecorded: "unrecorded", at: "at" } as const

export type RunStamp =
  | { readonly kind: typeof STAMP.unrecorded }
  | { readonly kind: typeof STAMP.at; readonly at: string }

export interface RunModelCall extends JsonRecord {
  readonly usage: RunCallMeter
  readonly admitted: RunStamp
  readonly responded: RunStamp
}

export const RUN_TIMING = { untimed: "untimed", timed: "timed" } as const

export type RunTiming =
  | { readonly kind: typeof RUN_TIMING.untimed }
  | {
      readonly kind: typeof RUN_TIMING.timed
      readonly duration_ms: number
      readonly tool_time_ms: number
      readonly steps: number
    }

export const TURN_PLACE = { unindexed: "unindexed", indexed: "indexed" } as const

export type RunTurnPlace =
  | { readonly kind: typeof TURN_PLACE.unindexed }
  | { readonly kind: typeof TURN_PLACE.indexed; readonly index: number }

export const CONTEXT_WINDOW = { unknown: "unknown", known: "known" } as const

export type RunContextWindow =
  | { readonly kind: typeof CONTEXT_WINDOW.unknown }
  | { readonly kind: typeof CONTEXT_WINDOW.known; readonly tokens: number }

export interface SessionRunUsage extends JsonRecord {
  readonly run_id: string
  readonly turn_id: string
  readonly turn: RunTurnPlace
  readonly status: RuntimeRunStatus
  readonly started_at: string
  readonly ended: RunStamp
  readonly model: RunModel
  readonly reasoning: RunReasoning
  readonly context_window: RunContextWindow
  readonly timing: RunTiming
  readonly calls: ReadonlyArray<RunModelCall>
}

export interface SessionUsageReport extends JsonRecord {
  readonly session_id: string
  readonly runs: ReadonlyArray<SessionRunUsage>
}

const IdentifierSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
const DaySchema = Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(10))

const RunModelSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RUN_MODEL.unrecorded) }),
  Schema.Struct({ kind: Schema.Literal(RUN_MODEL.model), model_id: Schema.NonEmptyString })
])

const UsageSpaceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(USAGE_SPACE.none) }),
  Schema.Struct({
    kind: Schema.Literal(USAGE_SPACE.space),
    space_id: Schema.NonEmptyString,
    name: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal(USAGE_SPACE.removed), space_id: Schema.NonEmptyString })
])

const linked = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal(USAGE_LINK.none) }),
    Schema.Struct({ kind: Schema.Literal(USAGE_LINK.linked), ...fields })
  ])

const tokenFields = {
  total: NonNegativeIntSchema,
  output: NonNegativeIntSchema,
  cache_read: NonNegativeIntSchema,
  cache_write: NonNegativeIntSchema
}

const UsageDailyCellSchema = withExtras({
  day: DaySchema,
  space: UsageSpaceSchema,
  origin: Schema.Literals(Object.values(USAGE_ORIGIN)),
  chat: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(USAGE_CHAT.none) }),
    Schema.Struct({ kind: Schema.Literal(USAGE_CHAT.chat), session_type: SessionTypeSchema })
  ]),
  model: RunModelSchema,
  kind: Schema.Literals(Object.values(MODEL_CALL_KIND)),
  ...tokenFields,
  cost: ProviderCostSchema,
  runs: NonNegativeIntSchema
})

const UsageTopSessionSchema = withExtras({
  session_id: IdentifierSchema,
  name: SessionNameSchema,
  space: UsageSpaceSchema,
  session_type: SessionTypeSchema,
  ...tokenFields,
  cost: ProviderCostSchema,
  runs: NonNegativeIntSchema,
  average_last_input: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(CONTEXT_SIZE.unmeasured) }),
    Schema.Struct({
      kind: Schema.Literal(CONTEXT_SIZE.measured),
      input_tokens: NonNegativeIntSchema
    })
  ])
})

const counts = {
  checks: NonNegativeIntSchema,
  runs: NonNegativeIntSchema,
  unaccounted_runs: NonNegativeIntSchema
}

const UsageAutomationRowSchema = withExtras({
  automation: linked({ task_id: Schema.NonEmptyString }),
  task: linked({ item_id: Schema.NonEmptyString }),
  space: linked({ space_id: Schema.NonEmptyString }),
  name: Schema.NonEmptyString,
  destination: linked({ destination: AppDestinationSchema }),
  purpose: Schema.Literals([
    "user_automation",
    "space_review",
    "task_execution",
    "system",
    "unrecorded"
  ] as const),
  handler: linked({ handler: Schema.NonEmptyString }),
  ...counts,
  total: NonNegativeIntSchema,
  cache_read: NonNegativeIntSchema,
  outcomes: Schema.Array(
    withExtras({
      outcome: Schema.Union([AutomationRunOutcomeSchema, Schema.Literal("unrecorded")]),
      ...counts,
      ...tokenFields
    })
  )
})

export const UsageReportSchema: Schema.Codec<UsageReport, JsonRecord> = withExtras({
  days: PositiveIntSchema,
  since: DaySchema,
  daily: Schema.Array(UsageDailyCellSchema),
  top_sessions: Schema.Array(UsageTopSessionSchema),
  automations: Schema.Array(UsageAutomationRowSchema)
})

const StampSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(STAMP.unrecorded) }),
  Schema.Struct({ kind: Schema.Literal(STAMP.at), at: IsoDateTimeStringSchema })
])

export const SessionUsageReportSchema: Schema.Codec<SessionUsageReport> = withExtras({
  session_id: IdentifierSchema,
  runs: Schema.Array(
    withExtras({
      run_id: IdentifierSchema,
      turn_id: IdentifierSchema,
      turn: Schema.Union([
        Schema.Struct({ kind: Schema.Literal(TURN_PLACE.unindexed) }),
        Schema.Struct({ kind: Schema.Literal(TURN_PLACE.indexed), index: NonNegativeIntSchema })
      ]),
      status: RuntimeRunStatusSchema,
      started_at: IsoDateTimeStringSchema,
      ended: StampSchema,
      model: Schema.Union([
        Schema.Struct({ kind: Schema.Literal(RUN_MODEL.unrecorded) }),
        Schema.Struct({ kind: Schema.Literal(RUN_MODEL.model), model_id: IdentifierSchema })
      ]),
      reasoning: Schema.Union([
        Schema.Struct({ kind: Schema.Literal(RUN_REASONING.default) }),
        Schema.Struct({ kind: Schema.Literal(RUN_REASONING.effort), effort: Schema.NonEmptyString })
      ]),
      context_window: Schema.Union([
        Schema.Struct({ kind: Schema.Literal(CONTEXT_WINDOW.unknown) }),
        Schema.Struct({ kind: Schema.Literal(CONTEXT_WINDOW.known), tokens: PositiveIntSchema })
      ]),
      timing: Schema.Union([
        Schema.Struct({ kind: Schema.Literal(RUN_TIMING.untimed) }),
        Schema.Struct({
          kind: Schema.Literal(RUN_TIMING.timed),
          duration_ms: NonNegativeIntSchema,
          tool_time_ms: NonNegativeIntSchema,
          steps: NonNegativeIntSchema
        })
      ]),
      calls: Schema.Array(
        withExtras({
          usage: Schema.Union([
            Schema.Struct({ kind: Schema.Literal(CALL_METER.awaiting) }),
            Schema.Struct({ kind: Schema.Literal(CALL_METER.metered), usage: RunUsageSchema })
          ]),
          admitted: StampSchema,
          responded: StampSchema
        })
      )
    })
  )
})
