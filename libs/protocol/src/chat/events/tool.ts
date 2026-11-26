import { SERVER_EVENT_TYPE } from "../../common/event-types.js"
import { Schema } from "effect"
import { event } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { JsonRecord } from "../../common/json.js"
import {
  GmailSendSchema,
  ToolDataSchema,
  ToolExecutionSchema,
  ToolFaceFields,
  ToolKindSchema,
  ToolRetrySchema,
  type GmailSend,
  type ToolData,
  type ToolExecution,
  type ToolFace,
  type ToolKind,
  type ToolRetry
} from "../tool-face.js"

export const TOOL_OUTPUT_STREAM = { stdout: "stdout", stderr: "stderr" } as const

export type ToolOutputStream = (typeof TOOL_OUTPUT_STREAM)[keyof typeof TOOL_OUTPUT_STREAM]

export interface ToolCallStartEvent extends JsonRecord, ToolFace {
  readonly type: typeof SERVER_EVENT_TYPE.toolCallStart
  readonly tool_call_id: string
  readonly tool_call_name: string
}

export interface ToolCallArgsEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.toolCallArgs
  readonly tool_call_id: string
  readonly delta: string
  readonly execution: ToolExecution
}

export interface ToolCallOutputDeltaEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.toolCallOutputDelta
  readonly tool_call_id: string
  readonly delta: string
  readonly stream: ToolOutputStream
  readonly execution: ToolExecution
}

export interface ToolCallProgressEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.toolCallProgress
  readonly tool_call_id: string
  readonly message: string
  readonly data: ToolData
  readonly execution: ToolExecution
}

export interface ToolCallWaitingEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.toolCallWaiting
  readonly tool_call_id: string
  readonly execution: ToolExecution
}

export interface ToolCallEndEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.toolCallEnd
  readonly tool_call_id: string
  readonly execution: ToolExecution
}

export interface ToolCallResultEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.toolCallResult
  readonly tool_call_id: string
  readonly name: string
  readonly content: string
  readonly preview: string
  readonly display_name: string
  readonly kind: ToolKind
  readonly is_error: boolean
  readonly retry: ToolRetry
  readonly duration_ms: number
  readonly data: ToolData
  readonly source_refs: ReadonlyArray<unknown>
  readonly gmail_send: GmailSend
  readonly execution: ToolExecution
}

export type ToolCallEvent =
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallOutputDeltaEvent
  | ToolCallProgressEvent
  | ToolCallWaitingEvent
  | ToolCallEndEvent
  | ToolCallResultEvent

export const ToolCallStartEventSchema = event(SERVER_EVENT_TYPE.toolCallStart, {
  tool_call_id: Schema.String,
  tool_call_name: Schema.String,
  ...ToolFaceFields
})

export const ToolCallArgsEventSchema = event(SERVER_EVENT_TYPE.toolCallArgs, {
  tool_call_id: Schema.String,
  delta: Schema.String,
  execution: ToolExecutionSchema
})

export const ToolCallOutputDeltaEventSchema = event(SERVER_EVENT_TYPE.toolCallOutputDelta, {
  tool_call_id: Schema.String,
  delta: Schema.String,
  stream: Schema.Literals(Object.values(TOOL_OUTPUT_STREAM)),
  execution: ToolExecutionSchema
})

export const ToolCallProgressEventSchema = event(SERVER_EVENT_TYPE.toolCallProgress, {
  tool_call_id: Schema.String,
  message: Schema.String,
  data: ToolDataSchema,
  execution: ToolExecutionSchema
})

export const ToolCallWaitingEventSchema = event(SERVER_EVENT_TYPE.toolCallWaiting, {
  tool_call_id: Schema.String,
  execution: ToolExecutionSchema
})

export const ToolCallEndEventSchema = event(SERVER_EVENT_TYPE.toolCallEnd, {
  tool_call_id: Schema.String,
  execution: ToolExecutionSchema
})

export const ToolCallResultEventSchema = event(SERVER_EVENT_TYPE.toolCallResult, {
  tool_call_id: Schema.String,
  name: Schema.String,
  content: Schema.String,
  preview: Schema.String,
  display_name: Schema.String,
  kind: ToolKindSchema,
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

export type ToolCallEventAgrees = Assert<
  Agrees<(typeof toolCallEventSchemas)[number]["Type"], ToolCallEvent>
>
