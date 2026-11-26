import { SERVER_EVENT_TYPE, eventTypeLiterals } from "../../common/event-types.js"
import { QuestionAnswerSchema } from "../schema-fields.js"
import { Schema } from "effect"
import { event, eventUsage, sessionEvent } from "../../common/schema.js"
import { InteractionSchema, AgentResultSchema } from "../interaction.js"
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
  readonly type: typeof SERVER_EVENT_TYPE.runStarted
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
  readonly type: typeof SERVER_EVENT_TYPE.sessionUpdated
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
  readonly type: typeof SERVER_EVENT_TYPE.runFinished
  readonly run_id: string
  readonly turn_id: string
  readonly usage: RunUsage
  readonly context: ContextSize
  readonly message_count: number
}

export interface RunCancelledEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.runCancelled
  readonly run_id: string
  readonly turn_id: string
}

export interface RunErrorEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.runError
  readonly run_id: string
  readonly turn_id: string
  readonly message: string
  readonly code: ChatRunErrorCode
}

export const TOKEN_USAGE_SCOPE = { run: "run", tool: "tool" } as const

export type TokenUsageScope = (typeof TOKEN_USAGE_SCOPE)[keyof typeof TOKEN_USAGE_SCOPE]

const tokenUsageScopes: ReadonlySet<unknown> = new Set<TokenUsageScope>(
  Object.values(TOKEN_USAGE_SCOPE)
)

export const isTokenUsageScope = (value: unknown): value is TokenUsageScope =>
  tokenUsageScopes.has(value)

export interface TokenUsageEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.tokenUsage
  readonly run_id: string
  readonly usage: EventUsage
  readonly context: ContextSize
  readonly message_count: number
  readonly scope: TokenUsageScope
}

export interface RunActivityEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.runActivity
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
  readonly type: typeof SERVER_EVENT_TYPE.thinking
  readonly status: string
  readonly run_id: string
}

export interface InputTakenEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.inputTaken
  readonly run_id: string
}

export interface StreamRetryEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.streamRetry
  readonly run_id: string
  readonly attempt: number
  readonly max_attempts: number
}

export interface ModelResponseResetEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.modelResponseReset
  readonly message_ids: ReadonlyArray<string>
  readonly tool_call_ids: ReadonlyArray<string>
}

export interface FinalTextSupersededEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.finalTextSuperseded
  readonly run_id: string
  readonly message_ids: ReadonlyArray<string>
  readonly state: "retrying" | "replaced"
}

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

export const RunStartedEventSchema = sessionEvent(SERVER_EVENT_TYPE.runStarted, Schema.String, {
  run_id: Schema.String,
  causes: Schema.Array(RunCauseSchema),
  turn_id: Schema.NonEmptyString
})

export const SessionUpdatedEventSchema = sessionEvent(
  SERVER_EVENT_TYPE.sessionUpdated,
  Schema.String,
  {
    name: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(SESSION_NAME.unnamed) }),
      Schema.Struct({ kind: Schema.Literal(SESSION_NAME.named), name: Schema.String })
    ])
  }
)

export const RunFinishedEventSchema = event(SERVER_EVENT_TYPE.runFinished, {
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString,
  usage: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_USAGE.unmetered) }),
    Schema.Struct({ kind: Schema.Literal(RUN_USAGE.metered), usage: eventUsage })
  ]),
  context: ContextSizeSchema,
  message_count: Schema.Number
})

export const RunCancelledEventSchema = event(SERVER_EVENT_TYPE.runCancelled, {
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString
})

export const CHAT_RUN_ERROR_CODE = {
  contextLengthExceeded: "context_length_exceeded",
  rateLimited: "rate_limited",
  providerAuth: "provider_auth",
  providerUnavailable: "provider_unavailable",
  providerError: "provider_error",
  requestInvalid: "request_invalid",
  modelUnavailable: "model_unavailable",
  toolPersistenceFailed: "tool_persistence_failed",
  runInterrupted: "run_interrupted",
  runnerError: "runner_error"
} as const

export type ChatRunErrorCode = (typeof CHAT_RUN_ERROR_CODE)[keyof typeof CHAT_RUN_ERROR_CODE]

export const ChatRunErrorCodeSchema = Schema.Literals(Object.values(CHAT_RUN_ERROR_CODE))

export const TRANSIENT_RUN_ERROR_CODES = [
  CHAT_RUN_ERROR_CODE.providerUnavailable,
  CHAT_RUN_ERROR_CODE.rateLimited,
  CHAT_RUN_ERROR_CODE.runInterrupted
] as const satisfies ReadonlyArray<ChatRunErrorCode>
export type TransientRunErrorCode = (typeof TRANSIENT_RUN_ERROR_CODES)[number]

const LASTING_RUN_ERROR_CODES = [
  CHAT_RUN_ERROR_CODE.modelUnavailable,
  CHAT_RUN_ERROR_CODE.providerAuth,
  CHAT_RUN_ERROR_CODE.requestInvalid
] as const satisfies ReadonlyArray<ChatRunErrorCode>
type LastingRunErrorCode = (typeof LASTING_RUN_ERROR_CODES)[number]

export const isLastingRunError = (code: string | null | undefined): code is LastingRunErrorCode =>
  LASTING_RUN_ERROR_CODES.some((lasting) => lasting === code)

export const RunErrorEventSchema = event(SERVER_EVENT_TYPE.runError, {
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString,
  message: Schema.String,
  code: ChatRunErrorCodeSchema
})

export const TokenUsageEventSchema = event(SERVER_EVENT_TYPE.tokenUsage, {
  run_id: Schema.String,
  usage: eventUsage,
  context: ContextSizeSchema,
  message_count: Schema.Number,
  scope: Schema.Literals(Object.values(TOKEN_USAGE_SCOPE))
})

export const RunActivityEventSchema = event(SERVER_EVENT_TYPE.runActivity, {
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

export const ThinkingEventSchema = event(SERVER_EVENT_TYPE.thinking, {
  status: Schema.String,
  run_id: Schema.String
})

export const InputTakenEventSchema = event(SERVER_EVENT_TYPE.inputTaken, { run_id: Schema.String })

export const StreamRetryEventSchema = event(SERVER_EVENT_TYPE.streamRetry, {
  run_id: Schema.String,
  attempt: Schema.Int,
  max_attempts: Schema.Int
})

export const ModelResponseResetEventSchema = event(SERVER_EVENT_TYPE.modelResponseReset, {
  message_ids: Schema.Array(Schema.String),
  tool_call_ids: Schema.Array(Schema.String)
})

export const FinalTextSupersededEventSchema = event(SERVER_EVENT_TYPE.finalTextSuperseded, {
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

export type RunLifecycleEventAgrees = Assert<
  Agrees<(typeof runLifecycleEventSchemas)[number]["Type"], RunLifecycleEvent>
>

export type RunTerminalEvent = RunFinishedEvent | RunErrorEvent | RunCancelledEvent

export const runTerminalEventSchemas = [
  RunFinishedEventSchema,
  RunErrorEventSchema,
  RunCancelledEventSchema
] as const

export type RunTerminalEventAgrees = Assert<
  Agrees<(typeof runTerminalEventSchemas)[number]["Type"], RunTerminalEvent>
>

const runTerminalEventTypes = eventTypeLiterals(runTerminalEventSchemas)

export const isRunTerminalEvent = <Event extends { readonly type: string }>(
  event: Event
): event is Extract<Event, { readonly type: RunTerminalEvent["type"] }> =>
  runTerminalEventTypes.has(event.type)

export const endsReadingMessage = (event: ChatServerEvent): boolean =>
  isRunTerminalEvent(event) ||
  event.type === SERVER_EVENT_TYPE.toolCallStart ||
  event.type === SERVER_EVENT_TYPE.textMessageStart ||
  event.type === SERVER_EVENT_TYPE.textMessageContent ||
  (event.type === SERVER_EVENT_TYPE.reasoningMessageContent && event.delta.trim().length > 0) ||
  (event.type === SERVER_EVENT_TYPE.reasoningMessageEnd &&
    event.closure.kind === MESSAGE_CLOSURE.complete &&
    event.closure.content.trim().length > 0)
