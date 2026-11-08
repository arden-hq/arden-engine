import { Schema } from "effect"
import {
  ToolOutcomeSchema,
  event,
  optionalBoolean,
  optionalInt,
  optionalNullableString,
  optionalString,
  optionalUnknown,
  unknownRecord
} from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import { GmailSendReceiptSchema } from "../gmail-receipt.js"
import type { CommonServerEventFields } from "../../common/event-fields.js"
import type { GmailSendReceipt, ToolOutcome } from "../history.js"
import type { JsonRecord } from "../../common/json.js"

export interface ToolCallStartEvent extends CommonServerEventFields {
  readonly type: "TOOL_CALL_START"
  readonly tool_call_id: string
  readonly tool_call_name: string
  readonly parent_id?: string | null
  readonly display_name?: string
  readonly display_title?: string
  readonly kind?: string
  readonly icon?: string | null
  readonly noun?: string | null
  readonly source?: string | null
  /** Which surface the call's result belongs to; history stamps the same. */
  readonly presentation?: "work" | "conversation" | "status"
  readonly execution?: "runtime" | "provider"
}

/**
 * Lossy presentation delta with no restating terminal on the stream: the
 * durable transcript (`historyToolCallSchema.arguments`) is authoritative.
 */
export interface ToolCallArgsEvent extends CommonServerEventFields {
  readonly type: "TOOL_CALL_ARGS"
  readonly tool_call_id: string
  readonly delta: string
  readonly execution?: "runtime" | "provider"
}

/** Lossy presentation delta. TOOL_CALL_RESULT restates the full output. */
export interface ToolCallOutputDeltaEvent extends CommonServerEventFields {
  readonly type: "TOOL_CALL_OUTPUT_DELTA"
  readonly tool_call_id: string
  readonly delta: string
  readonly stream: "stdout" | "stderr"
  readonly execution?: "runtime" | "provider"
}

/**
 * Fire-and-forget status line: may be dropped under backpressure and has no
 * restating terminal. Clients must not derive durable state from it.
 */
export interface ToolCallProgressEvent extends CommonServerEventFields {
  readonly type: "TOOL_CALL_PROGRESS"
  readonly tool_call_id: string
  readonly message: string
  readonly data?: JsonRecord
  readonly execution?: "runtime" | "provider"
}

/**
 * The call was announced but is held before its effect begins (queued behind
 * an earlier change that waits on a decision). It reads as waiting until a
 * later TOOL_CALL_START for the same call says it runs.
 */
export interface ToolCallWaitingEvent extends CommonServerEventFields {
  readonly type: "TOOL_CALL_WAITING"
  readonly tool_call_id: string
  readonly execution?: "runtime" | "provider"
}

export interface ToolCallEndEvent extends CommonServerEventFields {
  readonly type: "TOOL_CALL_END"
  readonly tool_call_id: string
  readonly execution?: "runtime" | "provider"
}

export interface ToolCallResultEvent extends CommonServerEventFields {
  readonly type: "TOOL_CALL_RESULT"
  readonly tool_call_id: string
  readonly name: string
  /** Authoritative full output: replaces accumulated TOOL_CALL_OUTPUT_DELTA. */
  readonly content?: string
  readonly preview?: string
  readonly display_name?: string
  readonly kind?: string
  readonly is_error?: boolean
  readonly retryable?: boolean | null
  readonly duration_ms?: number
  readonly data?: JsonRecord | null
  readonly source_refs?: unknown
  readonly outcome?: ToolOutcome | null
  readonly gmail_send_receipt?: GmailSendReceipt
  readonly role?: string
  readonly raw_ref?: string | null
  readonly content_sha256?: string | null
  readonly content_bytes?: number | null
  readonly retention_class?: string | null
  readonly execution?: "runtime" | "provider"
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
  parent_id: optionalNullableString,
  display_name: optionalString,
  display_title: optionalString,
  kind: optionalString,
  icon: optionalNullableString,
  noun: optionalNullableString,
  source: optionalNullableString,
  /** Which surface the call's result belongs to; the client groups a live
   *  call by the same rule history uses, so a card is a card on both paths. */
  presentation: Schema.optionalKey(Schema.Literals(["work", "conversation", "status"] as const)),
  execution: Schema.optionalKey(Schema.Literals(["runtime", "provider"] as const))
})

export const ToolCallArgsEventSchema = event("TOOL_CALL_ARGS", {
  tool_call_id: Schema.String,
  delta: Schema.String,
  execution: Schema.optionalKey(Schema.Literals(["runtime", "provider"] as const))
})

export const ToolCallOutputDeltaEventSchema = event("TOOL_CALL_OUTPUT_DELTA", {
  tool_call_id: Schema.String,
  delta: Schema.String,
  stream: Schema.Literals(["stdout", "stderr"] as const),
  execution: Schema.optionalKey(Schema.Literals(["runtime", "provider"] as const))
})

// Fire-and-forget: may be dropped under backpressure, no restating terminal.
export const ToolCallProgressEventSchema = event("TOOL_CALL_PROGRESS", {
  tool_call_id: Schema.String,
  message: Schema.String,
  data: Schema.optionalKey(unknownRecord),
  execution: Schema.optionalKey(Schema.Literals(["runtime", "provider"] as const))
})

export const ToolCallWaitingEventSchema = event("TOOL_CALL_WAITING", {
  tool_call_id: Schema.String,
  execution: Schema.optionalKey(Schema.Literals(["runtime", "provider"] as const))
})

export const ToolCallEndEventSchema = event("TOOL_CALL_END", {
  tool_call_id: Schema.String,
  execution: Schema.optionalKey(Schema.Literals(["runtime", "provider"] as const))
})

export const ToolCallResultEventSchema = event("TOOL_CALL_RESULT", {
  tool_call_id: Schema.String,
  name: Schema.String,
  content: optionalString,
  preview: optionalString,
  display_name: optionalString,
  kind: optionalString,
  is_error: optionalBoolean,
  retryable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  duration_ms: optionalInt,
  data: Schema.optionalKey(Schema.NullOr(unknownRecord)),
  source_refs: optionalUnknown,
  outcome: Schema.optionalKey(Schema.NullOr(ToolOutcomeSchema)),
  gmail_send_receipt: Schema.optionalKey(GmailSendReceiptSchema),
  role: optionalString,
  raw_ref: optionalNullableString,
  content_sha256: optionalNullableString,
  content_bytes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  retention_class: optionalNullableString,
  execution: Schema.optionalKey(Schema.Literals(["runtime", "provider"] as const))
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
