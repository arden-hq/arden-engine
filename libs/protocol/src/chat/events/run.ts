import { QuestionAnswerSchema } from "../schema-fields.js"
import { Schema } from "effect"
import {
  event,
  eventUsage,
  optionalBoolean,
  optionalNullableString,
  optionalNumber,
  optionalString,
  sessionEvent
} from "../../common/schema.js"
import { InteractionSchema, AgentResultSchema } from "../interaction.js"
import { eventTypeLiterals } from "../../common/event-types.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { AgentResult, Interaction } from "../history.js"
import type { ChatUpdate } from "../communication.js"
import { ChatUpdateSchema } from "../communication-schema.js"
import type { CommonServerEventFields, EventUsage } from "../../common/event-fields.js"

export interface RunStartedEvent extends CommonServerEventFields {
  readonly type: "RUN_STARTED"
  readonly run_id: string
  readonly session_id: string
  readonly integrations?: ReadonlyArray<string>
  readonly integration_errors?: Readonly<Record<string, string>>
  readonly session_name?: string | null
  readonly question_answer?: { readonly question_id: string }
  readonly agent_result?: AgentResult
  /** Who sent the message that started this run, when it was not the user. */
  readonly interaction?: Interaction
  /** The background update that started this run, drawn as its own row. */
  readonly update?: ChatUpdate
  readonly is_meta_run?: boolean
  readonly meta_client_id?: string | null
  readonly automation_task_id?: string
  readonly automation_name?: string
  readonly automation_prompt?: string
  readonly automation_context_mode?: "fresh" | "continue" | "fork"
  readonly turn_id: string
}

export interface SessionUpdatedEvent extends CommonServerEventFields {
  readonly type: "session_updated"
  readonly session_id: string
  readonly name?: string | null
}

export interface RunFinishedEvent extends CommonServerEventFields {
  readonly type: "RUN_FINISHED"
  readonly run_id: string
  readonly turn_id: string
  readonly usage?: EventUsage
  readonly context_input_tokens?: number | null
  readonly message_count?: number
}

export interface RunCancelledEvent extends CommonServerEventFields {
  readonly type: "run_cancelled"
  readonly run_id: string
  readonly turn_id: string
}

export interface RunErrorEvent extends CommonServerEventFields {
  readonly type: "RUN_ERROR"
  readonly run_id: string
  readonly turn_id: string
  readonly message: string
  readonly code?: ChatRunErrorCode
  readonly debug_id?: string | null
  readonly recoverable?: boolean
}

export interface TokenUsageEvent extends CommonServerEventFields {
  readonly type: "token_usage"
  readonly run_id: string
  readonly usage: EventUsage
  readonly cost?: number
  readonly context_input_tokens?: number | null
  readonly message_count?: number | null
  readonly scope?: "run" | "tool" | string
  readonly task_id?: string | null
  readonly child_run_id?: string | null
}

export interface RunActivityEvent extends CommonServerEventFields {
  readonly type: "run_activity"
  readonly run_id: string
  readonly tool_call_ids?: ReadonlyArray<string>
  readonly description: string
}

export interface ThinkingEvent extends CommonServerEventFields {
  readonly type: "thinking"
  readonly status: string
  readonly run_id?: string | null
}

/** Live-only: the run took an owner message into its history. The row reads it until the model acts. */
export interface InputTakenEvent extends CommonServerEventFields {
  readonly type: "input_taken"
  readonly run_id: string
}

/** Live-only reconnect status; never persisted, never a run failure. */
export interface StreamRetryEvent extends CommonServerEventFields {
  readonly type: "stream_retry"
  readonly run_id: string
  readonly attempt: number
  readonly max_attempts: number
}

export interface ModelResponseResetEvent extends CommonServerEventFields {
  readonly type: "model_response_reset"
  readonly message_ids: ReadonlyArray<string>
  readonly tool_call_ids: ReadonlyArray<string>
}

/**
 * The end-of-answer check sent the run's final answer back for a fix.
 * `retrying`: the model writes the answer again; the old answer stays on
 * screen until the new one completes. `replaced`: the new answer completed
 * and the old one (`message_ids`) left the transcript for good.
 */
export interface FinalTextSupersededEvent extends CommonServerEventFields {
  readonly type: "final_text_superseded"
  readonly run_id: string
  readonly message_ids: ReadonlyArray<string>
  readonly state: "retrying" | "replaced"
}

/** Run lifecycle: start, end, cancellation, failure, usage, status lines, and the response reset. */
export type RunLifecycleEvent =
  | RunStartedEvent
  | SessionUpdatedEvent
  | RunFinishedEvent
  | RunCancelledEvent
  | RunErrorEvent
  | TokenUsageEvent
  | ThinkingEvent
  | RunActivityEvent
  | StreamRetryEvent
  | InputTakenEvent
  | ModelResponseResetEvent
  | FinalTextSupersededEvent

export const RunStartedEventSchema = sessionEvent("RUN_STARTED", Schema.String, {
  run_id: Schema.String,
  integrations: Schema.optionalKey(Schema.Array(Schema.String)),
  integration_errors: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  session_name: optionalNullableString,
  is_meta_run: optionalBoolean,
  question_answer: Schema.optionalKey(QuestionAnswerSchema),
  agent_result: Schema.optionalKey(AgentResultSchema),
  interaction: Schema.optionalKey(InteractionSchema),
  update: Schema.optionalKey(ChatUpdateSchema),
  meta_client_id: optionalNullableString,
  automation_task_id: optionalString,
  automation_name: optionalString,
  automation_prompt: optionalString,
  automation_context_mode: Schema.optionalKey(
    Schema.Literals(["fresh", "continue", "fork"] as const)
  ),
  turn_id: Schema.NonEmptyString
})

export const SessionUpdatedEventSchema = sessionEvent("session_updated", Schema.String, {
  name: optionalNullableString
})

export const RunFinishedEventSchema = event("RUN_FINISHED", {
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString,
  usage: Schema.optionalKey(eventUsage),
  context_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  message_count: optionalNumber
})

export const RunCancelledEventSchema = event("run_cancelled", {
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString
})

/**
 * Closed classification of a failed run. Producers attach it where the failure
 * is thrown — the provider taxonomy in `@arden-hq/loop` supplies the first six —
 * and `RUN_ERROR.code` plus `chat_runs.error_code` carry nothing else. Clients
 * branch on the code; the message is display text, never a classifier.
 */
export type ChatRunErrorCode =
  | "context_length_exceeded"
  | "rate_limited"
  | "provider_auth"
  | "provider_unavailable"
  | "provider_error"
  | "request_invalid"
  | "model_unavailable"
  | "tool_persistence_failed"
  | "run_interrupted"
  | "runner_error"

export const ChatRunErrorCodeSchema = Schema.Literals([
  "context_length_exceeded",
  "rate_limited",
  "provider_auth",
  "provider_unavailable",
  "provider_error",
  "request_invalid",
  "model_unavailable",
  "tool_persistence_failed",
  "run_interrupted",
  "runner_error"
] as const)

/** A provider that could not be reached, asked to slow down, or a restart
 *  that cut the run off: weather, not a verdict on the work. Unattended work
 *  tries such a run again before it reports a failure. */
export const TRANSIENT_RUN_ERROR_CODES = [
  "provider_unavailable",
  "rate_limited",
  "run_interrupted"
] as const satisfies ReadonlyArray<ChatRunErrorCode>
export type TransientRunErrorCode = (typeof TRANSIENT_RUN_ERROR_CODES)[number]

/** A refusal that comes back the same until the person changes something: a
 *  model this account may not use, a sign-in the provider refuses, a request
 *  the provider will not take. Unattended work does not try it again; it
 *  stops where the person sees it, and their change (another model, a new
 *  sign-in, Retry) is what moves it on. `provider_error` is not one: it is
 *  also the loop's word for a failure nobody classified (a broken stream, a
 *  malformed call), which the next run may well not meet. */
const LASTING_RUN_ERROR_CODES = [
  "model_unavailable",
  "provider_auth",
  "request_invalid"
] as const satisfies ReadonlyArray<ChatRunErrorCode>
type LastingRunErrorCode = (typeof LASTING_RUN_ERROR_CODES)[number]

export const isLastingRunError = (code: string | null | undefined): code is LastingRunErrorCode =>
  LASTING_RUN_ERROR_CODES.some((lasting) => lasting === code)

export const RunErrorEventSchema = event("RUN_ERROR", {
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString,
  message: Schema.String,
  code: Schema.optionalKey(ChatRunErrorCodeSchema),
  debug_id: optionalNullableString,
  recoverable: optionalBoolean
})

export const TokenUsageEventSchema = event("token_usage", {
  run_id: Schema.String,
  usage: eventUsage,
  cost: optionalNumber,
  context_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  message_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  scope: optionalString,
  task_id: optionalNullableString,
  child_run_id: optionalNullableString
})

export const RunActivityEventSchema = event("run_activity", {
  run_id: Schema.NonEmptyString,
  tool_call_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  description: Schema.String.check(Schema.isMaxLength(160))
})

export const ThinkingEventSchema = event("thinking", {
  status: Schema.String,
  run_id: optionalNullableString
})

/**
 * Live-only reconnect status: a retryable provider-stream failure that the
 * transport is retrying under its bounded budget. The turn stays open, so this
 * is never a run failure and never enters the durable journal — a reader who
 * resumes mid-retry learns the state from the stream that follows, not history.
 */
/** Live-only: a reader that joins after it learns nothing and shows the run's ordinary status. */
export const InputTakenEventSchema = event("input_taken", { run_id: Schema.String })

export const StreamRetryEventSchema = event("stream_retry", {
  run_id: Schema.String,
  attempt: Schema.Int,
  max_attempts: Schema.Int
})

export const ModelResponseResetEventSchema = event("model_response_reset", {
  message_ids: Schema.Array(Schema.String),
  tool_call_ids: Schema.Array(Schema.String)
})

export const FinalTextSupersededEventSchema = event("final_text_superseded", {
  run_id: Schema.String,
  message_ids: Schema.Array(Schema.String),
  state: Schema.Literals(["retrying", "replaced"] as const)
})

export const runLifecycleEventSchemas = [
  RunStartedEventSchema,
  SessionUpdatedEventSchema,
  RunFinishedEventSchema,
  RunCancelledEventSchema,
  RunErrorEventSchema,
  TokenUsageEventSchema,
  ThinkingEventSchema,
  RunActivityEventSchema,
  StreamRetryEventSchema,
  InputTakenEventSchema,
  ModelResponseResetEventSchema,
  FinalTextSupersededEventSchema
] as const

/** @internal Compile-time check that the schema and the type agree. */
export type RunLifecycleEventAgrees = Assert<
  Agrees<(typeof runLifecycleEventSchemas)[number]["Type"], RunLifecycleEvent>
>

/** The events that end a Run: it finished, failed, or was cancelled. */
export type RunTerminalEvent = RunFinishedEvent | RunErrorEvent | RunCancelledEvent

/** The schemas of `RunTerminalEvent`, for sets that must hold every terminal event. */
export const runTerminalEventSchemas = [
  RunFinishedEventSchema,
  RunErrorEventSchema,
  RunCancelledEventSchema
] as const

/** @internal Compile-time check that the schema and the type agree. */
export type RunTerminalEventAgrees = Assert<
  Agrees<(typeof runTerminalEventSchemas)[number]["Type"], RunTerminalEvent>
>

const runTerminalEventTypes = eventTypeLiterals(runTerminalEventSchemas)

export const isRunTerminalEvent = <Event extends { readonly type: string }>(
  event: Event
): event is Extract<Event, { readonly type: RunTerminalEvent["type"] }> =>
  runTerminalEventTypes.has(event.type)

/**
 * The model acted on the owner's message: reasoning produced content, a tool
 * call began, answer text began or streamed, or the run ended. Empty reasoning
 * carriers do not count. Text counts as it streams too: the reply row a run
 * opens before it takes the message in starts no new message when its text
 * comes. This is the only rule that
 * ends "Reading your message", for the main chat and the agent peek alike.
 */
export const endsReadingMessage = (event: {
  readonly type: string
  readonly role?: string
  readonly delta?: string
  readonly content?: string
}): boolean =>
  isRunTerminalEvent(event) ||
  event.type === "TOOL_CALL_START" ||
  (event.type === "TEXT_MESSAGE_START" && event.role !== "user") ||
  event.type === "TEXT_MESSAGE_CONTENT" ||
  (event.type === "REASONING_MESSAGE_CONTENT" && Boolean(event.delta?.trim())) ||
  (event.type === "REASONING_MESSAGE_END" && Boolean(event.content?.trim()))
