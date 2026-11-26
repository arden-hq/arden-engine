import { Effect, Schema, type SchemaAST } from "effect"
import {
  IsoDateTimeStringSchema,
  PositiveIntSchema,
  RuntimeRunStatusSchema,
  withExtras
} from "../common/schema.js"
import { routeSegment } from "../common/routes.js"
import {
  AGENT_RUN,
  SCRIPT_END,
  SCRIPT_FAILURE,
  WORKFLOW_EFFECT,
  WORKFLOW_ERROR_CODE,
  WORKFLOW_PREVIEW,
  WORKFLOW_RECOVERY,
  type ScriptDetail,
  type ScriptSummary
} from "./contracts.js"
import { WORKFLOW_STATUS } from "./status.js"

const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }
const IdentifierSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const SourceRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))

export const WorkflowStatusSchema = Schema.Literals(Object.values(WORKFLOW_STATUS))

export const WorkflowEffectDispositionSchema = Schema.Literals(Object.values(WORKFLOW_EFFECT))

export const WorkflowErrorCodeSchema = Schema.Literals(Object.values(WORKFLOW_ERROR_CODE))

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
  recovery: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WORKFLOW_RECOVERY.none) }),
    Schema.Struct({ kind: Schema.Literal(WORKFLOW_RECOVERY.action), text: Schema.String })
  ]),
  preview: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WORKFLOW_PREVIEW.message) }),
    Schema.Struct({ kind: Schema.Literal(WORKFLOW_PREVIEW.line), text: Schema.String })
  ])
})

export const ScriptSummarySchema: Schema.Codec<ScriptSummary> = withExtras({
  workflow_ref: IdentifierSchema,
  version: PositiveIntSchema,
  status: WorkflowStatusSchema,
  attempt: PositiveIntSchema,
  origin_session_ref: IdentifierSchema,
  origin_run_id: IdentifierSchema,
  origin_tool_call_id: IdentifierSchema,
  failure: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SCRIPT_FAILURE.none) }),
    Schema.Struct({ kind: Schema.Literal(SCRIPT_FAILURE.failed), error: WorkflowErrorSchema })
  ]),
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  end: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SCRIPT_END.open) }),
    Schema.Struct({ kind: Schema.Literal(SCRIPT_END.ended), at: IsoDateTimeStringSchema })
  ])
})

const ScriptAgentSchema = withExtras({
  key: IdentifierSchema,
  attempts: Schema.Array(
    withExtras({
      session_ref: IdentifierSchema,
      tool_call_id: IdentifierSchema,
      run: Schema.Union([
        Schema.Struct({ kind: Schema.Literal(AGENT_RUN.none) }),
        Schema.Struct({
          kind: Schema.Literal(AGENT_RUN.run),
          run_id: IdentifierSchema,
          status: RuntimeRunStatusSchema
        })
      ])
    })
  ),
  label: Schema.String,
  mode: Schema.Literals(["research", "code", "work", "unrecorded"] as const),
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

export const WorkflowRefSchema = routeSegment()

export const ScriptOwnerQuerySchema = Schema.Struct({
  session_id: Schema.NonEmptyString.check(Schema.isMaxLength(512))
})

export const ScriptRetryRequestSchema = Schema.Struct({
  expected_version: PositiveIntSchema
})

export const encodeScriptRetryRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ScriptRetryRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
