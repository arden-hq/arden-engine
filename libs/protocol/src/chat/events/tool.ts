import { Schema } from "effect"
import { event } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { JsonRecord } from "../../common/json.js"
import {
  GmailSendSchema,
  ToolDataSchema,
  ToolExecutionSchema,
  ToolFaceFields,
  ToolRetrySchema,
  type GmailSend,
  type ToolData,
  type ToolExecution,
  type ToolFace,
  type ToolRetry
} from "../tool-face.js"

export interface ToolCallStartEvent extends JsonRecord, ToolFace {
  readonly type: "TOOL_CALL_START"
  readonly tool_call_id: string
  readonly tool_call_name: string
}

export interface ToolCallArgsEvent extends JsonRecord {
  readonly type: "TOOL_CALL_ARGS"
  readonly tool_call_id: string
  readonly delta: string
  readonly execution: ToolExecution
}

export interface ToolCallOutputDeltaEvent extends JsonRecord {
  readonly type: "TOOL_CALL_OUTPUT_DELTA"
  readonly tool_call_id: string
  readonly delta: string
  readonly stream: "stdout" | "stderr"
  readonly execution: ToolExecution
}

export interface ToolCallProgressEvent extends JsonRecord {
  readonly type: "TOOL_CALL_PROGRESS"
  readonly tool_call_id: string
  readonly message: string
  readonly data: ToolData
  readonly execution: ToolExecution
}

export interface ToolCallWaitingEvent extends JsonRecord {
  readonly type: "TOOL_CALL_WAITING"
  readonly tool_call_id: string
  readonly execution: ToolExecution
}

export interface ToolCallEndEvent extends JsonRecord {
  readonly type: "TOOL_CALL_END"
  readonly tool_call_id: string
  readonly execution: ToolExecution
}

export interface ToolCallResultEvent extends JsonRecord {
  readonly type: "TOOL_CALL_RESULT"
  readonly tool_call_id: string
  readonly name: string
  readonly content: string
  readonly preview: string
  readonly display_name: string
  readonly kind: string
  readonly is_error: boolean
  readonly retry: ToolRetry
  readonly duration_ms: number
  readonly data: ToolData
  readonly source_refs: ReadonlyArray<unknown>
  readonly gmail_send: GmailSend
  readonly execution: ToolExecution
}

/** Tool calls: start, argument and output deltas, progress, waiting, end, result. */
export type ToolCallEvent =
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallOutputDeltaEvent
  | ToolCallProgressEvent
  | ToolCallWaitingEvent
  | ToolCallEndEvent
  | ToolCallResultEvent

export const ToolCallStartEventSchema = event("TOOL_CALL_START", {
  tool_call_id: Schema.String,
  tool_call_name: Schema.String,
  ...ToolFaceFields
})

export const ToolCallArgsEventSchema = event("TOOL_CALL_ARGS", {
  tool_call_id: Schema.String,
  delta: Schema.String,
  execution: ToolExecutionSchema
})

export const ToolCallOutputDeltaEventSchema = event("TOOL_CALL_OUTPUT_DELTA", {
  tool_call_id: Schema.String,
  delta: Schema.String,
  stream: Schema.Literals(["stdout", "stderr"] as const),
  execution: ToolExecutionSchema
})

export const ToolCallProgressEventSchema = event("TOOL_CALL_PROGRESS", {
  tool_call_id: Schema.String,
  message: Schema.String,
  data: ToolDataSchema,
  execution: ToolExecutionSchema
})

export const ToolCallWaitingEventSchema = event("TOOL_CALL_WAITING", {
  tool_call_id: Schema.String,
  execution: ToolExecutionSchema
})

export const ToolCallEndEventSchema = event("TOOL_CALL_END", {
  tool_call_id: Schema.String,
  execution: ToolExecutionSchema
})

export const ToolCallResultEventSchema = event("TOOL_CALL_RESULT", {
  tool_call_id: Schema.String,
  name: Schema.String,
  content: Schema.String,
  preview: Schema.String,
  display_name: Schema.String,
  kind: Schema.String,
  is_error: Schema.Boolean,
  retry: ToolRetrySchema,
  duration_ms: Schema.Int,
  data: ToolDataSchema,
  source_refs: Schema.Array(Schema.Unknown),
  gmail_send: GmailSendSchema,
  execution: ToolExecutionSchema
})

export const toolCallEventSchemas = [
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallOutputDeltaEventSchema,
  ToolCallProgressEventSchema,
  ToolCallWaitingEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema
] as const

/** @internal Compile-time check that the schema and the type agree. */
export type ToolCallEventAgrees = Assert<
  Agrees<(typeof toolCallEventSchemas)[number]["Type"], ToolCallEvent>
>
