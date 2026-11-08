import { Schema } from "effect"
import { AutomationRunOutcomeSchema } from "../automations/outcome.js"
import { ChatProjectionEventSchema } from "../chat/schema.js"
import type { JsonRecord } from "../common/json.js"
import {
  AppDestinationSchema,
  IsoDateTimeStringSchema,
  RuntimeRunStatusSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"
import type {
  PlanLimitsReport,
  RunDetail,
  RunEventPage,
  SessionUsageReport,
  UsageReport
} from "./contracts.js"
import { MODEL_CALL_KINDS } from "./usage.js"
import { isActiveRunStatus } from "./status.js"

const NonNegativeNumberSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const IdentifierSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))

export const RunUsageSchema = withExtras({
  prompt: NonNegativeIntSchema,
  completion: NonNegativeIntSchema,
  total: NonNegativeIntSchema,
  cache_read: NonNegativeIntSchema,
  cache_write: NonNegativeIntSchema
})

export const RunTerminalResultSchema = withExtras({
  text: Schema.String,
  data: Schema.Json,
  usage: RunUsageSchema,
  cost: NonNegativeNumberSchema,
  duration_ms: NonNegativeIntSchema,
  tool_time_ms: NonNegativeIntSchema,
  steps: NonNegativeIntSchema,
  last_input_tokens: Schema.NullOr(NonNegativeIntSchema)
})

export const RunErrorSchema = withExtras({
  code: IdentifierSchema,
  message: Schema.String
})

export const RunLocalInstructionSourceSchema = withExtras({
  root: Schema.String,
  path: Schema.String,
  scope: Schema.String,
  status: Schema.Literals(["loaded", "empty", "unreadable", "truncated"] as const),
  digest: Schema.NullOr(Schema.String)
})

export const RunDetailSchema: Schema.Codec<RunDetail> = withExtras({
  version: Schema.Literal(1),
  run_id: IdentifierSchema,
  session_id: IdentifierSchema,
  turn_id: IdentifierSchema,
  status: RuntimeRunStatusSchema,
  started_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  ended_at: Schema.NullOr(IsoDateTimeStringSchema),
  stop_reason: Schema.NullOr(Schema.String),
  last_event_sequence: Schema.NullOr(NonNegativeIntSchema),
  model_id: Schema.NullOr(IdentifierSchema),
  reasoning_effort: Schema.NullOr(IdentifierSchema),
  client_id: Schema.NullOr(IdentifierSchema),
  result: Schema.NullOr(RunTerminalResultSchema),
  late_result_at: Schema.NullOr(IsoDateTimeStringSchema),
  error: Schema.NullOr(RunErrorSchema),
  local_instructions: Schema.optionalKey(Schema.Array(RunLocalInstructionSourceSchema))
}).check(
  Schema.makeFilter((run) => {
    const active = isActiveRunStatus(run.status)
    const issues: Array<Schema.FilterIssue> = []
    if (active && run.ended_at !== null) {
      issues.push({ path: ["ended_at"], issue: "must be null while the Run is active" })
    }
    if (!active && run.ended_at === null) {
      issues.push({ path: ["ended_at"], issue: "is required after the Run ends" })
    }
    if (active && (run.stop_reason !== null || run.result !== null || run.error !== null)) {
      issues.push({ path: ["status"], issue: "active Runs cannot have a terminal outcome" })
    }
    if (run.status !== "completed" && run.result !== null && run.late_result_at === null) {
      issues.push({
        path: ["result"],
        issue: "requires a late result timestamp for other terminal Runs"
      })
    }
    if (run.late_result_at !== null && (active || run.result === null)) {
      issues.push({
        path: ["late_result_at"],
        issue: "requires a terminal Run with a retained result"
      })
    }
    if (run.status === "completed" && run.error !== null) {
      issues.push({ path: ["error"], issue: "completed Runs cannot have an error" })
    }
    if (run.status === "error" && run.error === null) {
      issues.push({ path: ["error"], issue: "is required for failed Runs" })
    }
    if (run.status === "cancelled" && run.error !== null) {
      issues.push({ path: ["error"], issue: "cancelled Runs cannot have an error" })
    }
    return issues
  })
)

export const RunEventSchema = withExtras({
  sequence: PositiveIntSchema,
  created_at: IsoDateTimeStringSchema,
  event: ChatProjectionEventSchema
})

export const RunEventPageSchema: Schema.Codec<RunEventPage> = withExtras({
  run_id: IdentifierSchema,
  session_id: IdentifierSchema,
  trace_removed_at: Schema.NullOr(IsoDateTimeStringSchema),
  events: Schema.Array(RunEventSchema),
  next_after_sequence: NonNegativeIntSchema,
  has_more: Schema.Boolean
}).check(
  Schema.makeFilter((page) => {
    const issues: Array<Schema.FilterIssue> = []
    for (const [index, event] of page.events.entries()) {
      const previous = page.events[index - 1]
      if (previous !== undefined && event.sequence <= previous.sequence) {
        issues.push({ path: ["events", index, "sequence"], issue: "must increase" })
      }
    }
    const last = page.events.at(-1)
    if (last !== undefined && last.sequence !== page.next_after_sequence) {
      issues.push({ path: ["next_after_sequence"], issue: "must equal the last event sequence" })
    }
    return issues
  })
)

/** Query of `GET /chat/runs/:runId/events`. */
export const RunEventPageQuerySchema = Schema.Struct({
  after_sequence: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  ),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(200)
    )
  )
})

export const decodeRunTerminalResultEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(RunTerminalResultSchema)(value)

const SessionTypeSchema = Schema.Literals(["chat", "channel", "agent"] as const)

export const UsageDailyCellSchema = withExtras({
  day: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(10)),
  space_id: Schema.NullOr(Schema.NonEmptyString),
  space_name: Schema.NullOr(Schema.NonEmptyString),
  origin: Schema.Literals(["user", "automation"] as const),
  session_type: Schema.NullOr(SessionTypeSchema),
  model_id: Schema.NullOr(Schema.NonEmptyString),
  kind: Schema.Literals(MODEL_CALL_KINDS),
  total: NonNegativeIntSchema,
  output: NonNegativeIntSchema,
  cache_read: NonNegativeIntSchema,
  cache_write: NonNegativeIntSchema,
  runs: NonNegativeIntSchema
})

export const UsageTopSessionSchema = withExtras({
  session_id: IdentifierSchema,
  name: Schema.NullOr(Schema.String),
  space_id: Schema.NullOr(Schema.NonEmptyString),
  space_name: Schema.NullOr(Schema.NonEmptyString),
  session_type: SessionTypeSchema,
  total: NonNegativeIntSchema,
  output: NonNegativeIntSchema,
  cache_read: NonNegativeIntSchema,
  cache_write: NonNegativeIntSchema,
  runs: NonNegativeIntSchema,
  average_last_input: Schema.NullOr(NonNegativeIntSchema)
})

export const UsageAutomationOutcomeSchema = withExtras({
  outcome: Schema.NullOr(AutomationRunOutcomeSchema),
  checks: NonNegativeIntSchema,
  runs: NonNegativeIntSchema,
  unaccounted_runs: NonNegativeIntSchema,
  total: NonNegativeIntSchema,
  output: NonNegativeIntSchema,
  cache_read: NonNegativeIntSchema,
  cache_write: NonNegativeIntSchema
})

export const UsageAutomationRowSchema = withExtras({
  task_id: Schema.NullOr(Schema.NonEmptyString),
  item_id: Schema.NullOr(Schema.NonEmptyString),
  space_id: Schema.NullOr(Schema.NonEmptyString),
  name: Schema.NonEmptyString,
  destination: Schema.NullOr(AppDestinationSchema),
  purpose: Schema.NullOr(
    Schema.Literals(["user_automation", "space_review", "task_execution", "system"])
  ),
  handler: Schema.NullOr(Schema.NonEmptyString),
  checks: NonNegativeIntSchema,
  runs: NonNegativeIntSchema,
  unaccounted_runs: NonNegativeIntSchema,
  total: NonNegativeIntSchema,
  cache_read: NonNegativeIntSchema,
  outcomes: Schema.Array(UsageAutomationOutcomeSchema)
})

/** Query of `GET /usage`. */
export const UsageQuerySchema = Schema.Struct({
  days: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(365)
    )
  )
})

export const UsageReportSchema: Schema.Codec<UsageReport, JsonRecord> = withExtras({
  days: PositiveIntSchema,
  since: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(10)),
  daily: Schema.Array(UsageDailyCellSchema),
  top_sessions: Schema.Array(UsageTopSessionSchema),
  automations: Schema.Array(UsageAutomationRowSchema)
})

/** Query of `GET /usage/sessions/:sessionId`. */
export const SessionUsageQuerySchema = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(50)
    )
  )
})

export const SessionUsageReportSchema: Schema.Codec<SessionUsageReport> = withExtras({
  session_id: IdentifierSchema,
  runs: Schema.Array(
    withExtras({
      run_id: IdentifierSchema,
      turn_id: IdentifierSchema,
      turn_index: Schema.NullOr(NonNegativeIntSchema),
      status: RuntimeRunStatusSchema,
      started_at: IsoDateTimeStringSchema,
      ended_at: Schema.NullOr(IsoDateTimeStringSchema),
      model_id: Schema.NullOr(IdentifierSchema),
      reasoning_effort: Schema.NullOr(Schema.NonEmptyString),
      context_window: Schema.NullOr(PositiveIntSchema),
      timing: Schema.NullOr(
        withExtras({
          duration_ms: NonNegativeIntSchema,
          tool_time_ms: NonNegativeIntSchema,
          steps: NonNegativeIntSchema
        })
      ),
      calls: Schema.Array(
        withExtras({
          usage: Schema.NullOr(RunUsageSchema),
          admitted_at: Schema.NullOr(IsoDateTimeStringSchema),
          responded_at: Schema.NullOr(IsoDateTimeStringSchema)
        })
      )
    })
  )
})

const PlanWindowSchema = withExtras({
  used_percent: NonNegativeNumberSchema,
  window_seconds: PositiveIntSchema,
  resets_at: IsoDateTimeStringSchema,
  pace: withExtras({
    limit_percent: NonNegativeNumberSchema,
    elapsed_percent: NonNegativeNumberSchema,
    on_pace_percent: NonNegativeNumberSchema,
    ahead: Schema.Boolean,
    reaches_limit_at: Schema.NullOr(IsoDateTimeStringSchema)
  })
})

export const PlanLimitsReportSchema: Schema.Codec<PlanLimitsReport> = withExtras({
  plans: Schema.Array(
    withExtras({
      provider: Schema.NonEmptyString,
      plan: Schema.NullOr(Schema.NonEmptyString),
      windows: Schema.Array(PlanWindowSchema),
      credits: Schema.NullOr(
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("unlimited") }),
          Schema.Struct({
            kind: Schema.Literal("limited"),
            available: Schema.Boolean,
            balance: Schema.NullOr(NonNegativeNumberSchema)
          })
        ])
      ),
      observed_at: IsoDateTimeStringSchema
    })
  )
})
