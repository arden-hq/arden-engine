import type {
  AssistantTextPhase,
  ChatMessage,
  ContentBlock,
  JsonObject,
  MaybePromise,
  Metadata,
  ToolExecution
} from "./messages.js"
import type { CompletionResponse, Usage } from "./provider.js"
import type { HistoryChange } from "../agent/history-journal.js"
import type { HeldToolCall, PendingToolCall, ToolResult } from "./tools.js"

export const StopReason = {
  END_TURN: "end_turn",
  MAX_ITERATIONS: "max_iterations",
  MAX_TOOL_CALLS: "max_tool_calls",
  NO_PROGRESS: "no_progress",
  MAX_WALL_TIME: "max_wall_time",
  MAX_COST: "max_cost",
  MAX_TOKEN_BUDGET: "max_token_budget",
  MAX_OUTPUT_LENGTH: "max_output_length",
  CANCELLED: "cancelled",
  PAUSED: "paused"
} as const

export type StopReason = (typeof StopReason)[keyof typeof StopReason]

export const AGENT_EVENT_TAG = {
  textStarted: "TextStarted",
  textEnded: "TextEnded",
  textPhaseResolved: "TextPhaseResolved",
  textDelta: "TextDelta",
  reasoningStarted: "ReasoningStarted",
  reasoningDelta: "ReasoningDelta",
  reasoningEnded: "ReasoningEnded",
  modelStreamRetry: "ModelStreamRetry",
  inputTaken: "InputTaken",
  modelResponseReset: "ModelResponseReset",
  finalTextSuperseded: "FinalTextSuperseded",
  toolInputStarted: "ToolInputStarted",
  toolInputDelta: "ToolInputDelta",
  toolInputEnded: "ToolInputEnded",
  toolStarted: "ToolStarted",
  toolPaused: "ToolPaused",
  toolProgress: "ToolProgress",
  toolCompleted: "ToolCompleted"
} as const
export type AgentEventTag = (typeof AGENT_EVENT_TAG)[keyof typeof AGENT_EVENT_TAG]

export interface EventBase {
  readonly depth?: number
  readonly parent_id?: string | null
  readonly timestamp?: number
}

export interface TextStarted extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.textStarted
  readonly message_id: string
  readonly record_id: string
}

export interface TextEnded extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.textEnded
  readonly message_id: string
  readonly content: string
}

export interface TextPhaseResolved extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.textPhaseResolved
  readonly message_id: string
  readonly phase: AssistantTextPhase
}

export interface TextDelta extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.textDelta
  readonly content: string
  readonly message_id: string | null
}

export interface ReasoningStarted extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.reasoningStarted
  readonly message_id: string
  readonly record_id: string
}

export interface ReasoningDelta extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.reasoningDelta
  readonly message_id: string
  readonly content: string
}

export interface ReasoningEnded extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.reasoningEnded
  readonly message_id: string
}

export interface ModelStreamRetry extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.modelStreamRetry
  readonly attempt: number
  readonly max_attempts: number
}

export interface InputTaken extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.inputTaken
}

export interface ModelResponseReset extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.modelResponseReset
  readonly message_ids: ReadonlyArray<string>
  readonly tool_call_ids: ReadonlyArray<string>
}

export interface FinalTextSuperseded extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.finalTextSuperseded
  readonly message_ids: ReadonlyArray<string>
  readonly correction_message_id: string
}

export interface ToolInputStarted extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.toolInputStarted
  readonly tool_id: string
  readonly name: string
  readonly host: Metadata
}

export interface ToolInputDelta extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.toolInputDelta
  readonly tool_id: string
  readonly delta: string
}

export interface ToolInputEnded extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.toolInputEnded
  readonly tool_id: string
}

export interface ToolStarted extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.toolStarted
  readonly tool_id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly host: Metadata
  readonly execution?: ToolExecution
}

export interface ToolPaused extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.toolPaused
  readonly tool_id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly reason: string
  readonly detail: string
}

export interface ToolProgress extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.toolProgress
  readonly tool_call_id: string
  readonly name: string
  readonly message: string
  readonly data?: Readonly<Record<string, unknown>>
}

export const isToolPaused = (event: ToolCompleted | ToolPaused): event is ToolPaused =>
  event._tag === AGENT_EVENT_TAG.toolPaused

export interface ToolCompleted extends EventBase {
  readonly _tag: typeof AGENT_EVENT_TAG.toolCompleted
  readonly tool_id: string
  readonly name: string
  readonly result: string
  readonly preview: string
  readonly duration_ms: number
  readonly is_error: boolean
  readonly data: JsonObject | null
  readonly retryable: boolean | null
  readonly message_extras: Metadata
  readonly host: Metadata
  readonly execution?: ToolExecution
  readonly model_content: ReadonlyArray<ContentBlock>
  readonly ends_turn: boolean
}

export type AgentEvent =
  | TextStarted
  | TextEnded
  | TextPhaseResolved
  | TextDelta
  | ReasoningStarted
  | ReasoningDelta
  | ReasoningEnded
  | ModelStreamRetry
  | InputTaken
  | ModelResponseReset
  | FinalTextSuperseded
  | ToolInputStarted
  | ToolInputDelta
  | ToolInputEnded
  | ToolStarted
  | ToolProgress
  | ToolPaused
  | ToolCompleted

export interface PendingToolRequest {
  readonly tool_call_id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly reason: string
  readonly detail: string
}

export interface Result {
  readonly text: string
  readonly object?: unknown
  readonly stop_reason: StopReason
  readonly steps: number
  readonly usage: Usage
  readonly last_input_tokens: number | null
  readonly cost: number
  readonly duration_ms: number
  readonly tool_time_ms: number
  readonly paused_tools: ReadonlyArray<PendingToolRequest>
  readonly messages: ReadonlyArray<ChatMessage>
}

export type AgentStreamEvent = AgentEvent | Result

export interface AgentHooks {
  readonly onCheckpoint?: (
    messages: ReadonlyArray<ChatMessage>,
    change: HistoryChange
  ) => MaybePromise<void>
  readonly onResponse?: (
    response: CompletionResponse,
    messages: ReadonlyArray<ChatMessage>,
    change: HistoryChange
  ) => MaybePromise<void>
  readonly onStepFinish?: (
    step: number,
    response: CompletionResponse | null,
    messages: ReadonlyArray<ChatMessage>,
    change: HistoryChange
  ) => MaybePromise<void>
  readonly onError?: (cause: unknown) => MaybePromise<void>
  readonly onFinish?: (
    text: string,
    steps: number,
    messages: ReadonlyArray<ChatMessage>
  ) => MaybePromise<void>
  readonly hasPendingInput?: () => MaybePromise<boolean>
  readonly isOwnerMessage?: (message: ChatMessage) => boolean
  readonly getPendingMessages?: () => MaybePromise<ReadonlyArray<ChatMessage>>
  readonly waitForPendingMessages?: (signal: AbortSignal) => Promise<void>
  readonly recoverToolCalls?: (
    calls: ReadonlyArray<PendingToolCall>
  ) => MaybePromise<ReadonlyMap<string, ToolResult>>
  readonly holdBackgroundCalls?: (calls: ReadonlyArray<HeldToolCall>) => MaybePromise<void>
  readonly claimBackgroundCalls?: (
    toolCallIds: ReadonlyArray<string>
  ) => MaybePromise<ReadonlyMap<string, HeldToolCall>>
  readonly checkFinalText?: (text: string) => MaybePromise<string | undefined>
}

export interface RunBudgetSnapshot {
  readonly toolCalls: number
  readonly outputTokens: number
  readonly totalOutputTokens?: number
}

export interface RunBudget {
  readonly snapshot: () => MaybePromise<RunBudgetSnapshot>
  readonly reserveToolCalls: (count: number, limit?: number) => MaybePromise<boolean>
  readonly addOutputTokens: (count: number) => MaybePromise<RunBudgetSnapshot>
}

export interface RunBudgetOptions {
  readonly toolCalls?: number
  readonly outputTokens?: number
  readonly totalOutputTokens?: number
}

export interface RunPolicy {
  readonly finalizeInstruction?: string
  readonly fallbackResultText?: (messages: ReadonlyArray<ChatMessage>, reason: StopReason) => string
  readonly budgetDenialContent?: (reason: StopReason) => string
}
