import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras, PositiveIntSchema } from "../common/schema.js"
import { routeSegment } from "../common/routes.js"
import type { ScriptDetail, ScriptSummary } from "./contracts.js"
import { WORKFLOW_STATUSES } from "./status.js"

const strict = { onExcessProperty: "error" } as const
const IdentifierSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const SourceRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))

export const WorkflowStatusSchema = Schema.Literals(WORKFLOW_STATUSES)

export const WorkflowEffectDispositionSchema = Schema.Literals([
  "none",
  "no_op",
  "applied",
  "unknown"
] as const)

export const WorkflowErrorCodeSchema = Schema.Literals([
  "coordinator_failed",
  "agent_failed",
  "schema_invalid",
  "interrupted",
  "cancelled",
  "timed_out",
  "budget_exhausted",
  "conflict",
  "uncertain_effect",
  "storage",
  "internal"
] as const)

export const WorkflowSourceRefSchema = withExtras({
  provider: IdentifierSchema,
  kind: IdentifierSchema,
  ref: SourceRefSchema,
  title: Schema.String
})

export const WorkflowErrorSchema = withExtras({
  code: WorkflowErrorCodeSchema,
  message: Schema.String,
  retryable: Schema.Boolean,
  recovery_action: Schema.NullOr(Schema.String),
  preview: Schema.optionalKey(Schema.String)
})

export const ScriptSummarySchema: Schema.Codec<ScriptSummary> = withExtras({
  workflow_ref: IdentifierSchema,
  version: PositiveIntSchema,
  status: WorkflowStatusSchema,
  attempt: PositiveIntSchema,
  origin_session_ref: IdentifierSchema,
  origin_run_id: IdentifierSchema,
  origin_tool_call_id: IdentifierSchema,
  error: Schema.NullOr(WorkflowErrorSchema),
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  ended_at: Schema.NullOr(IsoDateTimeStringSchema)
})

const ScriptAgentSchema = withExtras({
  key: IdentifierSchema,
  attempts: Schema.Array(
    withExtras({
      session_ref: IdentifierSchema,
      run_id: Schema.NullOr(IdentifierSchema),
      tool_call_id: IdentifierSchema,
      status: Schema.String
    })
  ),
  label: Schema.String,
  mode: Schema.NullOr(Schema.Literals(["research", "code"] as const)),
  status: Schema.Literals(["running", "completed", "failed"] as const),
  session_ref: IdentifierSchema
})

export const ScriptDetailSchema: Schema.Codec<ScriptDetail> = withExtras({
  script: ScriptSummarySchema,
  agents: Schema.Array(ScriptAgentSchema),
  executions: Schema.Array(
    withExtras({
      attempt: PositiveIntSchema,
      data: Schema.Record(Schema.String, Schema.Json)
    })
  )
})

/** `:workflowRef` in every `/scripts/:workflowRef[/…]` route. */
export const WorkflowRefSchema = routeSegment()

/** Query of every script route: the owning Session. */
export const ScriptOwnerQuerySchema = Schema.Struct({
  session_id: Schema.NonEmptyString.check(Schema.isMaxLength(512))
})

export const ScriptRetryRequestSchema = Schema.Struct({
  expected_version: PositiveIntSchema
})

export const encodeScriptRetryRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ScriptRetryRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
