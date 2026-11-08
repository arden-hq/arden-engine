import type {
  AssistantTextPhase,
  ChatMessage,
  ContentBlock,
  JsonObject,
  MaybePromise,
  Metadata
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

export interface EventBase {
  readonly depth?: number
  readonly parent_id?: string | null
  readonly timestamp?: number
}

export interface TextStarted extends EventBase {
  readonly _tag: "TextStarted"
  readonly message_id: string
}

export interface TextEnded extends EventBase {
  readonly _tag: "TextEnded"
  readonly message_id: string
  readonly content: string
}

export interface TextPhaseResolved extends EventBase {
  readonly _tag: "TextPhaseResolved"
  readonly message_id: string
  readonly phase: AssistantTextPhase
}

export interface TextDelta extends EventBase {
  readonly _tag: "TextDelta"
  readonly content: string
  readonly message_id: string | null
}

export interface ReasoningStarted extends EventBase {
  readonly _tag: "ReasoningStarted"
  readonly message_id: string
}

export interface ReasoningDelta extends EventBase {
  readonly _tag: "ReasoningDelta"
  readonly message_id: string
  readonly content: string
}

export interface ReasoningEnded extends EventBase {
  readonly _tag: "ReasoningEnded"
  readonly message_id: string
}

export interface ModelStreamRetry extends EventBase {
  readonly _tag: "ModelStreamRetry"
  /** 1-based transport attempt that just failed. */
  readonly attempt: number
  /** Total attempts before the failure stands and the run fails. */
  readonly max_attempts: number
}

/**
 * The run took an owner message into its history: its first step started on
 * one, or a step boundary drained a new one. Live status only, never persisted.
 * Whatever the model does next (a tool call, answer text) is the reply.
 */
export interface InputTaken extends EventBase {
  readonly _tag: "InputTaken"
}

export interface ModelResponseReset extends EventBase {
  readonly _tag: "ModelResponseReset"
  readonly message_ids: ReadonlyArray<string>
  readonly tool_call_ids: ReadonlyArray<string>
}

/**
 * The final-text check (`hooks.checkFinalText`) rejected the run's answer:
 * Loop appended the correction and the model writes the answer again. The
 * rejected answer's records stay in this run's history, so the model sees
 * what it fixes; a host may drop them, and the correction, once the new
 * answer stands.
 */
export interface FinalTextSuperseded extends EventBase {
  readonly _tag: "FinalTextSuperseded"
  /** The assistant records of the model call that wrote the rejected answer. */
  readonly message_ids: ReadonlyArray<string>
  /** The meta user message that carries the correction. */
  readonly correction_message_id: string
}

export interface ToolInputStarted extends EventBase {
  readonly _tag: "ToolInputStarted"
  readonly tool_id: string
  readonly name: string
  readonly host: Metadata
}

export interface ToolInputDelta extends EventBase {
  readonly _tag: "ToolInputDelta"
  readonly tool_id: string
  readonly delta: string
}

export interface ToolInputEnded extends EventBase {
  readonly _tag: "ToolInputEnded"
  readonly tool_id: string
}

export interface ToolStarted extends EventBase {
  readonly _tag: "ToolStarted"
  readonly tool_id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly host: Metadata
  readonly execution?: "runtime" | "provider"
}

export interface ToolPaused extends EventBase {
  readonly _tag: "ToolPaused"
  readonly tool_id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly reason: string
  readonly detail: string
}

/**
 * A live progress update emitted by a running tool via `ToolContext.emit`.
 * Streamed between ToolStarted and ToolCompleted in emission order and never
 * persisted to history. Parallel tools interleave their progress events.
 */
export interface ToolProgress extends EventBase {
  readonly _tag: "ToolProgress"
  readonly tool_call_id: string
  readonly name: string
  readonly message: string
  readonly data?: Readonly<Record<string, unknown>>
}

export interface ToolCompleted extends EventBase {
  readonly _tag: "ToolCompleted"
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
  readonly execution?: "runtime" | "provider"
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

/** The terminal stream value. Deliberately tag-less: hosts discriminate via `"_tag" in event`. */
export interface Result {
  readonly text: string
  /** Parsed structured output; present only when the run validated an `output` schema. */
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
  /** Persist pending-call identity before background execution starts. */
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
  /** Non-consuming input admission check. Excludes background completion notifications. */
  readonly hasPendingInput?: () => MaybePromise<boolean>
  /**
   * Which user messages a person wrote, for `InputTaken`. Defaults to
   * `isHumanMessage` (no harness or agent interaction, not meta). A host that
   * also feeds plain user messages that no person typed (a headless client)
   * narrows it.
   */
  readonly isOwnerMessage?: (message: ChatMessage) => boolean
  readonly getPendingMessages?: () => MaybePromise<ReadonlyArray<ChatMessage>>
  /**
   * Resolves when input may be waiting for `getPendingMessages`. Loop races it
   * against background calls it waits on, so a message steers the run while a
   * long call keeps running. Stop listening when `signal` aborts.
   */
  readonly waitForPendingMessages?: (signal: AbortSignal) => Promise<void>
  readonly recoverToolCalls?: (
    calls: ReadonlyArray<PendingToolCall>
  ) => MaybePromise<ReadonlyMap<string, ToolResult>>
  /**
   * A pause leaves the run's background calls running. The host keeps them,
   * keyed by call id, so a resumed run can claim them and a stop of the run
   * (cancel, delete) can still abort them through `stop`.
   */
  readonly holdBackgroundCalls?: (calls: ReadonlyArray<HeldToolCall>) => MaybePromise<void>
  /**
   * The resumed run's pending background calls still alive in this process,
   * from what `holdBackgroundCalls` kept. A claimed call is waited on and
   * delivered, never recovered as uncertain; the rest go to `recoverToolCalls`.
   */
  readonly claimBackgroundCalls?: (
    toolCallIds: ReadonlyArray<string>
  ) => MaybePromise<ReadonlyMap<string, HeldToolCall>>
  /**
   * Checks the run's final text before the run ends. A returned string is a
   * correction: Loop appends it as a meta user message and the model writes
   * its final answer again. Called at most once per run; the second answer
   * stands whatever it holds.
   */
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
