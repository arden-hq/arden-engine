import type { RunCancelTarget } from "./send-contracts.js"
import type { HandlerItemRef } from "../automations/handler-item.js"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import type { StoredRunUsage } from "../runs/stored-result.js"
import type { ToolResult } from "@arden-hq/loop"
import type {
  ChatApprovalMode,
  ChatImageInput,
  ChatReceiptStatus,
  ChatRunErrorCode
} from "@arden-hq/protocol/chat"
import type { ModelRole } from "@arden-hq/protocol/models"
import type { ChatSentFrom } from "@arden-hq/protocol/chat"
import type { RunMemoryComposition } from "@arden-hq/protocol/runs"
import type { StoredRunTerminalResult as RunTerminalResult } from "../runs/stored-result.js"
import type { StoredMessageEnvelope } from "../transcript/model.js"
import type { JsonObject } from "../json.js"
import type { CommittedEventBatch } from "../events/model.js"
import type { ToolExecutionIdentity } from "../tools/store.js"
import { Context, Effect, Schema, type Scope } from "effect"
import type { CodeAgentWorkspace } from "../../sessions/agent-mode.js"
import type { LocalInstructionManifestEntry } from "../../context/local-instructions.js"
import type { JobLeaseRef } from "@arden-hq/jobs"
import type { AutomationId } from "../automations/model.js"
import type { PlanReading, QuotaPauseReason } from "../../models/plan-limits.js"

export interface ChatAutomationOrigin {
  readonly automationId: AutomationId
  readonly name: string
}

export interface TaskStepCause {
  readonly itemId: string
  readonly afterRunId?: string
}

export const REQUEST_HASH_VERSION = 3

export interface ChatWriteStartInput {
  readonly approvalReply?: { readonly runId: string; readonly toolId: string }
  readonly deliveryId?: string
  readonly admittedWith?: ReadonlyArray<string>
  readonly sessionId: string
  readonly clientId: string
  readonly requestHash: string
  readonly assistantMessageId: string
  readonly message: StoredMessageEnvelope
  readonly approvalMode?: ChatApprovalMode
  readonly modelId?: string
  readonly announce?: true
  readonly modelRole?: ModelRole
  readonly automation?: ChatAutomationOrigin & { readonly attemptId: number }
  readonly automationLease?: JobLeaseRef
  readonly handlerItem?: HandlerItemRef
  readonly automationPrompt?: string
  readonly automationContextMode?: AutomationContextMode
  readonly outputSchema?: JsonObject
  readonly continuesTask?: TaskStepCause
  readonly capture?: ChatCaptureInput
  readonly fromQueue?: true
  readonly opensOnboarding?: true
}

export interface ChatCaptureInput {
  readonly via: "screenshot" | "quick" | "phone"
  readonly note: string
  readonly screenshot: boolean
}

export interface ChatWriteReceiveInput extends ChatWriteStartInput {
  readonly wake: boolean
}

export interface ChatWriteFinishInput {
  readonly runId: string
  readonly messages: ReadonlyArray<StoredMessageEnvelope>
  readonly result?: RunTerminalResult
  readonly stopReason?: string
  readonly usage?: StoredRunUsage
  readonly lastInputTokens?: number | null
  readonly terminalTextEnded?: boolean
  readonly supersededMessageIds?: ReadonlyArray<string>
}

export interface ChatWriteTerminalResult {
  readonly committed: ChatWriteCommit
}

export const CHAT_WRITE_FINISH = { completed: "Completed", continued: "Continued" } as const

interface ChatWriteFinishCompleted extends ChatWriteTerminalResult {
  readonly _tag: typeof CHAT_WRITE_FINISH.completed
}

interface ChatWriteFinishContinued {
  readonly _tag: typeof CHAT_WRITE_FINISH.continued
  readonly activeMessages: ReadonlyArray<StoredMessageEnvelope>
  readonly assistantMessageId: string
  readonly eventSequence: number
  readonly committed: ChatWriteCommit
}

export type ChatWriteFinishResult = ChatWriteFinishCompleted | ChatWriteFinishContinued

export interface ChatWriteCheckpointInput {
  readonly completionMessageId?: string
  readonly runId: string
  readonly messages: ReadonlyArray<StoredMessageEnvelope>
  readonly appendFrom?: ChatCheckpointAnchor
  readonly eventSequence?: number
  readonly lastInputTokens?: number
}

export interface ChatCheckpointAnchor {
  readonly contextGeneration: number
  readonly activeCount: number
  readonly lastMessage: StoredMessageEnvelope | null
}

export interface ChatWriteFailInput {
  readonly runId: string
  readonly code: ChatRunErrorCode
  readonly message: string
}

export interface ChatWriteCancelResult {
  readonly runId: string
  readonly sessionId: string
  readonly descendantRunIds: ReadonlyArray<string>
  readonly committed: ChatWriteCommit
}

export interface ChatWriteResume {
  readonly runId: string
  readonly sessionId: string
  readonly assistantMessageId: string
  readonly mintedMessageIds: ReadonlyArray<string>
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly approvalMode: ChatApprovalMode
  readonly outputSchema: JsonObject | null
  readonly automation: ChatAutomationOrigin | null
  readonly automationContextMode: AutomationContextMode | null
  readonly turnId: string
  readonly activeMessages: ReadonlyArray<StoredMessageEnvelope>
  readonly eventSequence: number
  readonly scheduling: ChatRunScheduling
}

export const CHAT_RUN_SCHEDULING = {
  unrestricted: "unrestricted",
  agentTree: "agent_tree"
} as const

export type ChatRunScheduling =
  | { readonly kind: typeof CHAT_RUN_SCHEDULING.unrestricted }
  | {
      readonly kind: typeof CHAT_RUN_SCHEDULING.agentTree
      readonly treeRootSessionId: string
      readonly maxConcurrentAgents: number
    }

interface ChatWriteSpawnAgentInputBase {
  readonly parent: ToolExecutionIdentity
  readonly task: string
  readonly name?: string
  readonly taskItemId?: string
  readonly outputSchema?: JsonObject
  readonly model?: string
  readonly reasoningEffort?: string
  readonly defaultModel?: { readonly model: string; readonly reasoningEffort: string | null }
  readonly forkHistory?: ReadonlyArray<Readonly<Record<string, unknown>>>
}

export type ChatWriteSpawnAgentInput =
  | (ChatWriteSpawnAgentInputBase & { readonly mode: "research" | "work" })
  | (ChatWriteSpawnAgentInputBase & {
      readonly mode: "code"
      readonly requestedWorkingDirectory?: string
      readonly workspace: CodeAgentWorkspace
    })

export interface ChatWriteSpawnAgentResult {
  readonly result: ToolResult
  readonly child: ChatWriteResume
}

export const CHAT_AGENT_SPAWN_REASON = {
  invalidParent: "invalid_parent",
  maxDepth: "max_depth",
  workingDirectory: "working_directory"
} as const

export class ChatAgentSpawnError extends Schema.TaggedError<ChatAgentSpawnError>()(
  "ChatAgentSpawnError",
  {
    reason: Schema.Literals(Object.values(CHAT_AGENT_SPAWN_REASON)),
    retryable: Schema.Boolean,
    message: Schema.String,
    runId: Schema.optionalKey(Schema.NonEmptyString),
    toolCallId: Schema.optionalKey(Schema.NonEmptyString),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const CHAT_WRITE_FAILURE = {
  invalid: "invalid",
  not_found: "not_found",
  corrupt: "corrupt",
  storage: "storage",
  terminal: "terminal"
} as const

export class ChatWriteError extends Schema.TaggedError<ChatWriteError>()("ChatWriteError", {
  operation: Schema.Literals([
    "start",
    "drain",
    "checkpoint",
    "finish",
    "fail",
    "cancel",
    "spawn_agent",
    "fork_session",
    "list_resumable",
    "claim_resume",
    "interrupt_stranded",
    "enqueue",
    "list_queued",
    "reorder_queued",
    "cancel_queued",
    "due_queue_heads",
    "fail_queued",
    "post"
  ] as const),
  reason: Schema.Literals(Object.values(CHAT_WRITE_FAILURE)),
  message: Schema.String,
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  runId: Schema.optionalKey(Schema.NonEmptyString),
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class ChatWriteConflictError extends Schema.TaggedError<ChatWriteConflictError>()(
  "ChatWriteConflictError",
  {
    sessionId: Schema.NonEmptyString,
    clientId: Schema.NonEmptyString,
    message: Schema.String,
    kind: Schema.optionalKey(Schema.Literals(["session_busy", "task_idle", "queue_changed"]))
  }
) {}

export type ChatWriteFailure = ChatWriteError | ChatWriteConflictError
export type ChatWriteSpawnAgentFailure = ChatWriteFailure | ChatAgentSpawnError

type ChatWriteCommit = CommittedEventBatch

export const CHAT_WRITE_START = {
  started: "Started",
  existing: "Existing",
  queued: "Queued"
} as const

interface ChatWriteStarted {
  readonly _tag: typeof CHAT_WRITE_START.started
  readonly runId: string
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly approvalMode: ChatApprovalMode
  readonly outputSchema: JsonObject | null
  readonly automation: ChatAutomationOrigin | null
  readonly automationContextMode: AutomationContextMode | null
  readonly turnId: string
  readonly activeMessages: ReadonlyArray<StoredMessageEnvelope>
  readonly committed: ChatWriteCommit
  readonly scheduling: ChatRunScheduling
}

interface ChatWriteExisting {
  readonly _tag: typeof CHAT_WRITE_START.existing
  readonly runId: string
  readonly status: ChatReceiptStatus
}

interface ChatWriteQueued {
  readonly _tag: typeof CHAT_WRITE_START.queued
  readonly runId: string
}

export type ChatWriteStartResult = ChatWriteStarted | ChatWriteExisting | ChatWriteQueued

export const CHAT_WRITE_STORED = { stored: "Stored" } as const

export type ChatWriteReceiveResult =
  | ChatWriteStartResult
  | { readonly _tag: typeof CHAT_WRITE_STORED.stored }

export interface ChatQueueEnqueueInput {
  readonly sessionId: string
  readonly clientId: string
  readonly message: string
  readonly images: ReadonlyArray<ChatImageInput>
  readonly sentFrom?: ChatSentFrom
}

export interface ChatQueuedMessage {
  readonly clientId: string
  readonly message: string
  readonly images: ReadonlyArray<ChatImageInput>
  readonly enqueuedAt: string
  readonly sentFrom?: ChatSentFrom
  readonly failedReason?: string
}

export interface ChatQueueHead extends ChatQueuedMessage {
  readonly sessionId: string
}

export const MODEL_ADMISSION = { admitted: "admitted", paused: "paused" } as const

export type ModelAdmission =
  | { readonly kind: typeof MODEL_ADMISSION.admitted }
  | {
      readonly kind: typeof MODEL_ADMISSION.paused
      readonly reason: QuotaPauseReason
      readonly until: string
    }

export class ChatWriteStore extends Context.Service<
  ChatWriteStore,
  {
    readonly executionBudget: (runId: string) => Effect.Effect<
      {
        readonly remainingTokens: number | null
      },
      ChatWriteFailure
    >
    readonly sessionTreeRoot: (sessionId: string) => Effect.Effect<string, ChatWriteFailure>
    readonly admitModelRequest: (
      runId: string,
      sampleId: string,
      plan?: PlanReading
    ) => Effect.Effect<ModelAdmission, ChatWriteFailure>
    readonly recordModelUsage: (input: {
      readonly runId: string
      readonly sampleId: string
      readonly usage: RunTerminalResult["usage"]
    }) => Effect.Effect<void, ChatWriteFailure>
    readonly recordLocalInstructions: (input: {
      readonly runId: string
      readonly sources: ReadonlyArray<LocalInstructionManifestEntry>
    }) => Effect.Effect<void, ChatWriteFailure>
    readonly recordMemoryContext: (input: {
      readonly runId: string
      readonly sessionId: string
      readonly context: RunMemoryComposition
    }) => Effect.Effect<void, ChatWriteFailure>
    readonly recordLateOutcome: (input: {
      readonly runId: string
      readonly result: RunTerminalResult
    }) => Effect.Effect<void, ChatWriteFailure>
    readonly prepareReceive: (
      input: ChatWriteReceiveInput
    ) => Effect.Effect<Effect.Effect<ChatWriteReceiveResult, ChatWriteFailure>, ChatWriteFailure>
    readonly receive: (
      input: ChatWriteReceiveInput
    ) => Effect.Effect<ChatWriteReceiveResult, ChatWriteFailure>
    readonly start: (
      input: ChatWriteStartInput
    ) => Effect.Effect<ChatWriteStartResult, ChatWriteFailure>
    readonly drainPending: (
      runId: string
    ) => Effect.Effect<ReadonlyArray<StoredMessageEnvelope>, ChatWriteFailure>
    readonly peekPendingInput: (runId: string) => Effect.Effect<boolean, ChatWriteFailure>
    readonly checkpoint: (
      input: ChatWriteCheckpointInput
    ) => Effect.Effect<ChatCheckpointAnchor, ChatWriteFailure>
    readonly finish: (
      input: ChatWriteFinishInput
    ) => Effect.Effect<ChatWriteFinishResult, ChatWriteFailure>
    readonly fail: (
      input: ChatWriteFailInput
    ) => Effect.Effect<ChatWriteTerminalResult, ChatWriteFailure>
    readonly cancel: (
      input: RunCancelTarget
    ) => Effect.Effect<ChatWriteCancelResult, ChatWriteFailure>
    readonly stopEndedWork: (input: RunCancelTarget) => Effect.Effect<
      {
        readonly runIds: ReadonlyArray<string>
        readonly descendantRunIds: ReadonlyArray<string>
      },
      ChatWriteFailure
    >
    readonly prepareSpawnAgent: (
      input: ChatWriteSpawnAgentInput
    ) => Effect.Effect<
      Effect.Effect<ChatWriteSpawnAgentResult, ChatWriteSpawnAgentFailure>,
      ChatWriteSpawnAgentFailure
    >
    readonly spawnAgent: (
      input: ChatWriteSpawnAgentInput
    ) => Effect.Effect<ChatWriteSpawnAgentResult, ChatWriteSpawnAgentFailure>
    readonly interruptStranded: (input: {
      readonly ownedRunIds: ReadonlyArray<string>
    }) => Effect.Effect<ReadonlyArray<string>, ChatWriteFailure>
    readonly sideRunsAwaitingApproval: () => Effect.Effect<ReadonlyArray<string>, ChatWriteFailure>
    readonly enqueue: (
      input: ChatQueueEnqueueInput
    ) => Effect.Effect<ChatQueuedMessage, ChatWriteFailure>
    readonly listQueued: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<ChatQueuedMessage>, ChatWriteFailure>
    readonly reorderQueued: (input: {
      readonly sessionId: string
      readonly clientIds: ReadonlyArray<string>
    }) => Effect.Effect<ReadonlyArray<ChatQueuedMessage>, ChatWriteFailure>
    readonly cancelQueued: (input: {
      readonly sessionId: string
      readonly clientId: string
    }) => Effect.Effect<boolean, ChatWriteFailure>
    readonly onEnqueue: (wake: () => void) => Effect.Effect<void, never, Scope.Scope>
    readonly dueQueueHeads: () => Effect.Effect<ReadonlyArray<ChatQueueHead>, ChatWriteFailure>
    readonly failQueued: (input: {
      readonly sessionId: string
      readonly clientId: string
      readonly reason: string
    }) => Effect.Effect<void, ChatWriteFailure>
    readonly listResumable: () => Effect.Effect<ReadonlyArray<string>, ChatWriteFailure>
    readonly claimResume: (runId: string) => Effect.Effect<ChatWriteResume | null, ChatWriteFailure>
  }
>()("@arden-hq/server/persistence/chat/ChatWriteStore") {}
