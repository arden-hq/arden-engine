import { Schema } from "effect"
import type { Effect } from "effect"
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
import {
  LOCAL_INSTRUCTION_STATUS,
  PROVIDER_COST,
  RUN_CLIENT,
  RUN_EVENTS_SEEN,
  RUN_FAILURE,
  RUN_MODEL,
  RUN_REASONING,
  RUN_RESULT,
  RUN_STOP_REASON,
  RUN_TRACE
} from "./contracts.js"
import type {
  PlanLimitsReport,
  RunDetail,
  RunEventPage,
  RunMemoryContext,
  RunMemorySource,
  SessionUsageReport,
  UsageReport
} from "./contracts.js"
import { MODEL_CALL_KINDS } from "./usage.js"
import { RunCursorPageNextSchema } from "./list-options.js"
import { ACTIVE_RUN_STATUSES, RUN_STATUS, TERMINAL_RUN_STATUSES } from "./status.js"
import { CONTEXT_SIZE } from "../chat/events/run.js"

const NonNegativeNumberSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const IdentifierSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))

const ProviderCostSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(PROVIDER_COST.unreported) }),
  Schema.Struct({ kind: Schema.Literal(PROVIDER_COST.reported), usd: NonNegativeNumberSchema })
])

const ContextSizeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CONTEXT_SIZE.unmeasured) }),
  Schema.Struct({ kind: Schema.Literal(CONTEXT_SIZE.measured), input_tokens: NonNegativeIntSchema })
])

export const RunUsageSchema = withExtras({
  prompt: NonNegativeIntSchema,
  completion: NonNegativeIntSchema,
  total: NonNegativeIntSchema,
  cache_read: NonNegativeIntSchema,
  cache_write: NonNegativeIntSchema,
  cost: ProviderCostSchema
})

export const RunTerminalResultSchema = withExtras({
  text: Schema.String,
  data: Schema.Json,
  usage: RunUsageSchema,
  duration_ms: NonNegativeIntSchema,
  tool_time_ms: NonNegativeIntSchema,
  steps: NonNegativeIntSchema,
  context: ContextSizeSchema
})

export const RunErrorSchema = withExtras({
  code: IdentifierSchema,
  message: Schema.String
})

const localInstructionPlace = { root: Schema.String, path: Schema.String, scope: Schema.String }

export const RunLocalInstructionSourceSchema = Schema.Union([
  withExtras({
    ...localInstructionPlace,
    status: Schema.Literals([LOCAL_INSTRUCTION_STATUS.loaded, LOCAL_INSTRUCTION_STATUS.truncated]),
    digest: Schema.String
  }),
  withExtras({
    ...localInstructionPlace,
    status: Schema.Literals([LOCAL_INSTRUCTION_STATUS.empty, LOCAL_INSTRUCTION_STATUS.unreadable])
  })
])

const RunMemoryOutcomeSchema = Schema.Literals(["whole", "passage", "cut", "dropped"] as const)
const RunMemoryCutReasonSchema = Schema.Literals([
  "standing_page_allowance",
  "index_allowance",
  "space_page_allowance",
  "recall_allowance"
] as const)
const memoryPlacement = {
  bytes: NonNegativeIntSchema,
  outcome: RunMemoryOutcomeSchema,
  reason: Schema.NullOr(RunMemoryCutReasonSchema)
}

const pageFields = {
  page_id: IdentifierSchema,
  version: IdentifierSchema,
  ...memoryPlacement
}

/** One Memory source of a composition: identity and bytes, never text. */
const RunMemorySourceSchema: Schema.Codec<RunMemorySource> = Schema.Union([
  withExtras({
    kind: Schema.Literal("space"),
    space_id: IdentifierSchema,
    page_id: Schema.NullOr(IdentifierSchema),
    version: Schema.NullOr(IdentifierSchema),
    ...memoryPlacement
  }),
  withExtras({ kind: Schema.Literal("core"), ...pageFields }),
  withExtras({
    kind: Schema.Literal("recalled"),
    role: Schema.optionalKey(Schema.Literals(["knowledge", "record", "contract"] as const)),
    ...pageFields
  }),
  withExtras({
    kind: Schema.Literal("index"),
    root: Schema.String,
    listed: NonNegativeIntSchema,
    folded: Schema.Array(withExtras({ folder: Schema.String, pages: PositiveIntSchema })),
    ...memoryPlacement
  })
]).check(
  Schema.makeFilter((source) =>
    (source.outcome === "cut" || source.outcome === "dropped") === (source.reason !== null)
      ? undefined
      : { path: ["reason"], issue: "names the limit exactly when the source was cut or dropped" }
  )
)

/** The one shape of a stored Memory composition; a Run's record is a list of them. */
export const RunMemoryContextSchema: Schema.Codec<RunMemoryContext> = withExtras({
  reader: Schema.Literals(["owner", "worker"] as const),
  revision: Schema.NullOr(IdentifierSchema),
  query: Schema.NullOr(Schema.String),
  budget: Schema.optionalKey(
    withExtras({
      standing_page: PositiveIntSchema,
      standing_frame: PositiveIntSchema,
      index: Schema.optionalKey(PositiveIntSchema),
      space: PositiveIntSchema,
      space_instructions: PositiveIntSchema,
      space_page: PositiveIntSchema,
      space_page_list: PositiveIntSchema,
      recall: PositiveIntSchema
    })
  ),
  sources: Schema.Array(RunMemorySourceSchema)
})

const runDetailFields = {
  version: Schema.Literal(1),
  run_id: IdentifierSchema,
  session_id: IdentifierSchema,
  turn_id: IdentifierSchema,
  started_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  events: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_EVENTS_SEEN.none) }),
    Schema.Struct({ kind: Schema.Literal(RUN_EVENTS_SEEN.through), sequence: NonNegativeIntSchema })
  ]),
  model: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_MODEL.unrecorded) }),
    Schema.Struct({ kind: Schema.Literal(RUN_MODEL.model), model_id: IdentifierSchema })
  ]),
  reasoning: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_REASONING.default) }),
    Schema.Struct({ kind: Schema.Literal(RUN_REASONING.effort), effort: IdentifierSchema })
  ]),
  client: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_CLIENT.none) }),
    Schema.Struct({ kind: Schema.Literal(RUN_CLIENT.client), client_id: IdentifierSchema })
  ]),
  local_instructions: Schema.Array(RunLocalInstructionSourceSchema),
  memory_context: Schema.Array(RunMemoryContextSchema)
}

const RunResultStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RUN_RESULT.none) }),
  Schema.Struct({ kind: Schema.Literal(RUN_RESULT.on_time), result: RunTerminalResultSchema }),
  Schema.Struct({
    kind: Schema.Literal(RUN_RESULT.late),
    result: RunTerminalResultSchema,
    at: IsoDateTimeStringSchema
  })
])

const RunFailureSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RUN_FAILURE.none) }),
  Schema.Struct({
    kind: Schema.Literal(RUN_FAILURE.failed),
    code: IdentifierSchema,
    message: Schema.String
  })
])

export const RunDetailSchema: Schema.Codec<RunDetail> = Schema.Union([
  withExtras({ ...runDetailFields, status: Schema.Literals(ACTIVE_RUN_STATUSES) }),
  withExtras({
    ...runDetailFields,
    status: Schema.Literals(TERMINAL_RUN_STATUSES),
    ended_at: IsoDateTimeStringSchema,
    stop_reason: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(RUN_STOP_REASON.unstated) }),
      Schema.Struct({ kind: Schema.Literal(RUN_STOP_REASON.stated), reason: Schema.String })
    ]),
    result: RunResultStateSchema,
    failure: RunFailureSchema
  }).check(
    Schema.makeFilter((run) => {
      const issues: Array<Schema.FilterIssue> = []
      if (run.status !== RUN_STATUS.completed && run.result.kind === RUN_RESULT.on_time) {
        issues.push({
          path: ["result"],
          issue: "requires a late result timestamp for other terminal Runs"
        })
      }
      if (run.status === RUN_STATUS.completed && run.failure.kind === RUN_FAILURE.failed) {
        issues.push({ path: ["failure"], issue: "completed Runs cannot have an error" })
      }
      if (run.status === RUN_STATUS.error && run.failure.kind === RUN_FAILURE.none) {
        issues.push({ path: ["failure"], issue: "is required for failed Runs" })
      }
      if (run.status === RUN_STATUS.cancelled && run.failure.kind === RUN_FAILURE.failed) {
        issues.push({ path: ["failure"], issue: "cancelled Runs cannot have an error" })
      }
      return issues
    })
  )
])

export const RunEventSchema = withExtras({
  sequence: PositiveIntSchema,
  created_at: IsoDateTimeStringSchema,
  event: ChatProjectionEventSchema
})

export const RunEventPageSchema: Schema.Codec<RunEventPage> = withExtras({
  run_id: IdentifierSchema,
  session_id: IdentifierSchema,
  trace: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_TRACE.kept) }),
    Schema.Struct({ kind: Schema.Literal(RUN_TRACE.removed), at: IsoDateTimeStringSchema })
  ]),
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

export const decodeRunTerminalResultEffect = (
  value: unknown
): Effect.Effect<Schema.Schema.Type<typeof RunTerminalResultSchema>, Schema.SchemaError, never> =>
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
  cost: Schema.optionalKey(NonNegativeNumberSchema),
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
  cost: Schema.optionalKey(NonNegativeNumberSchema),
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

export const UsageReportSchema: Schema.Codec<UsageReport, JsonRecord> = withExtras({
  days: PositiveIntSchema,
  since: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(10)),
  daily: Schema.Array(UsageDailyCellSchema),
  top_sessions: Schema.Array(UsageTopSessionSchema),
  automations: Schema.Array(UsageAutomationRowSchema)
})

/**
 * `GET /chat/runs`: a page of the server's Runs, oldest first, sub-agent Runs
 * included. `next` is present when more Runs follow; pass it as `after` to
 * read on. `idle` is true when no Run is going, no script runs in the
 * background and no Automation delivery waits, so nothing more will happen
 * until the next message. It speaks for the whole server, whatever the page
 * or filter.
 */
export const RunListSchema = withExtras({
  runs: Schema.Array(
    withExtras({
      run_id: IdentifierSchema,
      session_id: IdentifierSchema,
      status: Schema.NonEmptyString,
      /** True while the Run still owns its chat: not yet ended. */
      active: Schema.Boolean,
      started_at: Schema.NonEmptyString
    })
  ),
  next: RunCursorPageNextSchema,
  idle: Schema.Boolean
})
export type RunList = typeof RunListSchema.Type

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
