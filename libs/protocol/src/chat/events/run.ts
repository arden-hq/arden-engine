import { QuestionAnswerSchema } from "../schema-fields.js"
import { Schema } from "effect"
import { event, eventUsage, sessionEvent } from "../../common/schema.js"
import { InteractionSchema, AgentResultSchema } from "../interaction.js"
import { eventTypeLiterals } from "../../common/event-types.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { AgentResult, Interaction } from "../history.js"
import type { ChatUpdate } from "../communication.js"
import { ChatUpdateSchema } from "../communication-schema.js"
import type { ChatServerEvent } from "./stream.js"
import { MESSAGE_CLOSURE } from "./text.js"
import { PROVIDER_COST, type EventUsage } from "../../common/event-fields.js"
import type { JsonRecord } from "../../common/json.js"

export const RUN_CAUSE = {
  questionAnswer: "question_answer",
  agentResult: "agent_result",
  interaction: "interaction",
  update: "update",
  automation: "automation"
} as const

export const AUTOMATION_PROMPT = { own: "own", delegated: "delegated" } as const

export type AutomationPrompt =
  | { readonly kind: typeof AUTOMATION_PROMPT.own; readonly text: string }
  | { readonly kind: typeof AUTOMATION_PROMPT.delegated }

export type RunCause =
  | { readonly kind: typeof RUN_CAUSE.questionAnswer; readonly question_id: string }
  | { readonly kind: typeof RUN_CAUSE.agentResult; readonly agent_result: AgentResult }
  | { readonly kind: typeof RUN_CAUSE.interaction; readonly interaction: Interaction }
  | { readonly kind: typeof RUN_CAUSE.update; readonly update: ChatUpdate }
  | {
      readonly kind: typeof RUN_CAUSE.automation
      readonly task_id: string
      readonly name: string
      readonly prompt: AutomationPrompt
      readonly context_mode: "fresh" | "continue" | "fork"
    }

export interface RunStartedEvent extends JsonRecord {
  readonly type: "RUN_STARTED"
  readonly run_id: string
  readonly session_id: string
  readonly causes: ReadonlyArray<RunCause>
  readonly turn_id: string
}

export const SESSION_NAME = { unnamed: "unnamed", named: "named" } as const

export type SessionName =
  | { readonly kind: typeof SESSION_NAME.unnamed }
  | { readonly kind: typeof SESSION_NAME.named; readonly name: string }

export interface SessionUpdatedEvent extends JsonRecord {
  readonly type: "session_updated"
  readonly session_id: string
  readonly name: SessionName
}

export const RUN_USAGE = { unmetered: "unmetered", metered: "metered" } as const

export type RunUsage =
  | { readonly kind: typeof RUN_USAGE.unmetered }
  | { readonly kind: typeof RUN_USAGE.metered; readonly usage: EventUsage }

export const CONTEXT_SIZE = { unmeasured: "unmeasured", measured: "measured" } as const

export type ContextSize =
  | { readonly kind: typeof CONTEXT_SIZE.unmeasured }
  | { readonly kind: typeof CONTEXT_SIZE.measured; readonly input_tokens: number }

export const contextSize = (inputTokens: number | null | undefined): ContextSize =>
  inputTokens === undefined || inputTokens === null
    ? { kind: CONTEXT_SIZE.unmeasured }
    : { kind: CONTEXT_SIZE.measured, input_tokens: inputTokens }

export const contextUsage = (counts: {
  readonly prompt: number
  readonly completion: number
  readonly cache_read: number
  readonly cache_write: number
}): EventUsage => ({
  ...counts,
  total: counts.prompt + counts.completion + counts.cache_read + counts.cache_write,
  cost: { kind: PROVIDER_COST.unreported }
})

export interface RunFinishedEvent extends JsonRecord {
  readonly type: "RUN_FINISHED"
  readonly run_id: string
  readonly turn_id: string
  readonly usage: RunUsage
  readonly context: ContextSize
  readonly message_count: number
}

export interface RunCancelledEvent extends JsonRecord {
  readonly type: "run_cancelled"
  readonly run_id: string
  readonly turn_id: string
}

export interface RunErrorEvent extends JsonRecord {
  readonly type: "RUN_ERROR"
  readonly run_id: string
  readonly turn_id: string
  readonly message: string
  readonly code: ChatRunErrorCode
}

export interface TokenUsageEvent extends JsonRecord {
  readonly type: "token_usage"
  readonly run_id: string
  readonly usage: EventUsage
  readonly context: ContextSize
  readonly message_count: number
  readonly scope: "run" | "tool" | string
}

export interface RunActivityEvent extends JsonRecord {
  readonly type: "run_activity"
  readonly run_id: string
  readonly target: RunActivityTarget
  readonly description: string
}

export const RUN_ACTIVITY_TARGET = { run: "run", calls: "calls" } as const

export type RunActivityTarget =
  | { readonly kind: typeof RUN_ACTIVITY_TARGET.run }
  | {
      readonly kind: typeof RUN_ACTIVITY_TARGET.calls
      readonly tool_call_ids: ReadonlyArray<string>
    }

export interface ThinkingEvent extends JsonRecord {
  readonly type: "thinking"
  readonly status: string
  readonly run_id: string
}

/** Live-only: the run took an owner message into its history. The row reads it until the model acts. */
export interface InputTakenEvent extends JsonRecord {
  readonly type: "input_taken"
  readonly run_id: string
}

/** Live-only reconnect status; never persisted, never a run failure. */
export interface StreamRetryEvent extends JsonRecord {
  readonly type: "stream_retry"
  readonly run_id: string
  readonly attempt: number
  readonly max_attempts: number
}

export interface ModelResponseResetEvent extends JsonRecord {
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
export interface FinalTextSupersededEvent extends JsonRecord {
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

const ContextSizeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CONTEXT_SIZE.unmeasured) }),
  Schema.Struct({ kind: Schema.Literal(CONTEXT_SIZE.measured), input_tokens: Schema.Number })
])

const RunCauseSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(RUN_CAUSE.questionAnswer),
    question_id: QuestionAnswerSchema.fields.question_id
  }),
  Schema.Struct({ kind: Schema.Literal(RUN_CAUSE.agentResult), agent_result: AgentResultSchema }),
  Schema.Struct({ kind: Schema.Literal(RUN_CAUSE.interaction), interaction: InteractionSchema }),
  Schema.Struct({ kind: Schema.Literal(RUN_CAUSE.update), update: ChatUpdateSchema }),
  Schema.Struct({
    kind: Schema.Literal(RUN_CAUSE.automation),
    task_id: Schema.String,
    name: Schema.String,
    prompt: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(AUTOMATION_PROMPT.own), text: Schema.String }),
      Schema.Struct({ kind: Schema.Literal(AUTOMATION_PROMPT.delegated) })
    ]),
    context_mode: Schema.Literals(["fresh", "continue", "fork"] as const)
  })
])

export const RunStartedEventSchema = sessionEvent("RUN_STARTED", Schema.String, {
  run_id: Schema.String,
  causes: Schema.Array(RunCauseSchema),
  turn_id: Schema.NonEmptyString
})

export const SessionUpdatedEventSchema = sessionEvent("session_updated", Schema.String, {
  name: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SESSION_NAME.unnamed) }),
    Schema.Struct({ kind: Schema.Literal(SESSION_NAME.named), name: Schema.String })
  ])
})

export const RunFinishedEventSchema = event("RUN_FINISHED", {
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString,
  usage: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_USAGE.unmetered) }),
    Schema.Struct({ kind: Schema.Literal(RUN_USAGE.metered), usage: eventUsage })
  ]),
  context: ContextSizeSchema,
  message_count: Schema.Number
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
  code: ChatRunErrorCodeSchema
})

export const TokenUsageEventSchema = event("token_usage", {
  run_id: Schema.String,
  usage: eventUsage,
  context: ContextSizeSchema,
  message_count: Schema.Number,
  scope: Schema.String
})

export const RunActivityEventSchema = event("run_activity", {
  run_id: Schema.NonEmptyString,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_ACTIVITY_TARGET.run) }),
    Schema.Struct({
      kind: Schema.Literal(RUN_ACTIVITY_TARGET.calls),
      tool_call_ids: Schema.Array(Schema.String)
    })
  ]),
  description: Schema.String.check(Schema.isMaxLength(160))
})

export const ThinkingEventSchema = event("thinking", {
  status: Schema.String,
  run_id: Schema.String
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
export const endsReadingMessage = (event: ChatServerEvent): boolean =>
  isRunTerminalEvent(event) ||
  event.type === "TOOL_CALL_START" ||
  event.type === "TEXT_MESSAGE_START" ||
  event.type === "TEXT_MESSAGE_CONTENT" ||
  (event.type === "REASONING_MESSAGE_CONTENT" && event.delta.trim().length > 0) ||
  (event.type === "REASONING_MESSAGE_END" &&
    event.closure.kind === MESSAGE_CLOSURE.complete &&
    event.closure.content.trim().length > 0)
