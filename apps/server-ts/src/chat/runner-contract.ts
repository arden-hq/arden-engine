import type { ChatApprovalMode, ChatImageInput, ChatReceipt } from "@arden-hq/protocol/chat"
import type { ModelPhaseTiming } from "@arden-hq/protocol/daemon"
import type {
  AgentStreamEvent,
  ChatMessage,
  HeldToolCall,
  ImageInputLimits,
  Interaction,
  JsonObject,
  ToolResult
} from "@arden-hq/loop"
import type { HistoryChange } from "@arden-hq/loop"
import type { RunPolicy } from "../execution/policy.js"
import type { RunAuthority } from "../execution/authority.js"
import type { EffectTarget, EffectTargetOrigin, ToolEffect } from "../execution/tool-effect.js"
import type { CodeAgentWorkspace } from "../sessions/agent-mode.js"
import type { AutomationId } from "../persistence/automations/model.js"

/** Full plain message history exposed to a host model runner. */
export type ChatRunnerMessage = ChatMessage

export interface ChatRunnerToolRequest {
  readonly toolCallId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly changesState: boolean
  /** Where the call's effect lands; custom runners may omit it, and an
   * omitted effect is read as "may have changed anything". */
  readonly effect?: ToolEffect
  /** Server-owned tool source. Custom runners may omit it; omitted sources
   * can never create standing permissions. */
  readonly source?: string
}

interface ChatRunnerSpawnAgentRequestBase {
  readonly toolCallId: string
  /** The call's validated arguments, exactly as the durable tool-call row records them. */
  readonly arguments: Readonly<Record<string, unknown>>
  readonly task: string
  readonly name?: string
  readonly taskItemId?: string
  /** Constrains the child's final answer through the provider. */
  readonly outputSchema?: JsonObject
  readonly model?: string
  readonly reasoningEffort?: string
  /** The parent's model-visible history at the call: the child starts from it (fork_context). */
  readonly forkHistory?: ReadonlyArray<ChatRunnerMessage>
}

export type ChatRunnerSpawnAgentRequest =
  | (ChatRunnerSpawnAgentRequestBase & { readonly mode: "research" | "work" })
  | (ChatRunnerSpawnAgentRequestBase & {
      readonly mode: "code"
      /** Raw model argument retained as part of the durable tool-call identity. */
      readonly requestedWorkingDirectory?: string
      /** Canonical authority snapshotted before the child is created. */
      readonly workspace: CodeAgentWorkspace
    })

export interface ChatRunnerSendMessageRequest {
  /** Start a turn when idle; false stores the input for the next turn. */
  readonly wake?: boolean
  readonly sessionId: string
  readonly clientId: string
  readonly message: string
  /** A handed capture's screenshot, moved into the chat it belongs to (`forward_message`). */
  readonly images?: ReadonlyArray<ChatImageInput>
  readonly interaction?: Interaction
  /** A plain user message no client drew as it was sent; its chat's viewers reload. */
  readonly announce?: true
  /** The chat this message is handed over from: it reads there as Arden's handoff. */
  readonly fromChat?: { readonly sessionId: string; readonly sessionRef: string }
  /** Server-owned invisible input used for automatic background results. */
  readonly isMeta?: true
  /** Server-owned durable identity for one Workflow result delivery. */
  readonly workflowDelivery?: {
    readonly workflowRef: string
    readonly attempt: number
  }
}

interface ChatRunnerToolProgressRequest {
  readonly toolCallId: string
  readonly message: string
  readonly data?: JsonObject
}

interface ChatRunnerToolOutputRequest {
  readonly toolCallId: string
  readonly stream: "stdout" | "stderr"
  readonly delta: string
}

/** Optional host context supplied when a durable tool operation resumes. */
export interface ChatRunnerToolOperationContext {
  readonly approval?: {
    readonly approved: true
    readonly feedback: string | null
    readonly data?: JsonObject
  }
}

/** Plain host boundary for durable tool execution and exact-result recovery. */
export interface ChatRunnerTools {
  readonly execute: (
    request: ChatRunnerToolRequest,
    operation: (context?: ChatRunnerToolOperationContext) => ToolResult | PromiseLike<ToolResult>,
    options?: {
      /** The loop moved this still-running call to the background (`ToolCallRequest.backgrounded`). */
      readonly backgrounded?: Promise<void>
    }
  ) => Promise<ToolResult>
  /** Execute a durable nested operation after its originating model turn ends. */
  readonly executeDetached: (
    request: ChatRunnerToolRequest,
    operation: (context?: ChatRunnerToolOperationContext) => ToolResult | PromiseLike<ToolResult>
  ) => Promise<ToolResult>
  /** Keep the background calls a pause left running, for a resume or a stop. */
  readonly holdBackground: (calls: ReadonlyArray<HeldToolCall>) => void
  /** This run's pending background calls still running in this process. */
  readonly claimBackground: (
    toolCallIds: ReadonlyArray<string>
  ) => ReadonlyMap<string, HeldToolCall>
  readonly recover: (
    calls: ReadonlyArray<ChatRunnerToolRequest>
  ) => Promise<ReadonlyMap<string, ToolResult>>
  /** Start one independent child Session and return its durable reference. */
  readonly spawnAgent: (request: ChatRunnerSpawnAgentRequest) => Promise<ToolResult>
  /** Cancel one active child-agent Run through the durable Chat owner. */
  readonly cancelAgent: (input: { readonly runId: string }) => Promise<void>
  /** Queue a message through the same durable Chat owner as the Desktop. */
  readonly sendMessage: (request: ChatRunnerSendMessageRequest) => Promise<ChatReceipt>
  /**
   * Rebuild the durable nested-tool host of another run, as the HTTP retry and
   * boot resume do: a detached script retried from a later turn runs on the
   * run that started it, where its journal lives.
   */
  readonly detachedRun: (input: {
    readonly sessionId: string
    readonly runId: string
  }) => Promise<ServerToolRun>
  readonly emitToolProgress: (request: ChatRunnerToolProgressRequest) => Promise<void>
  /** Emit live tool output. Lossy: TOOL_CALL_RESULT restates the whole. */
  readonly emitToolOutput: (request: ChatRunnerToolOutputRequest) => Promise<void>
  /** Store the object a running call is about to write outside Arden (`CallEffects.target`). */
  readonly declareEffectTarget: (request: {
    readonly toolCallId: string
    readonly target: EffectTarget
    readonly origin: EffectTargetOrigin
  }) => Promise<void>
}

/** What the latest provider response cost to send: the live context reading. */
export interface ChatRunnerContextReport {
  /** Prompt + cache read + cache write tokens of the latest response. */
  readonly inputTokens: number
  readonly usage: {
    readonly prompt: number
    readonly completion: number
    readonly cache_read: number
    readonly cache_write: number
  }
}

/** Host-owned model boundary. Structured Loop events remain plain TypeScript values. */
export interface ChatRunnerInput {
  /** Optional host observer; timings never participate in durable writes. */
  readonly reportModelTiming?: (timing: ModelPhaseTiming) => void
  readonly executionBudget: () => Promise<{ readonly remainingTokens: number | null }>
  readonly admitModelRequest: (sampleId: string) => Promise<void>
  readonly sessionId: string
  /** Root of this Session's parent chain; every run in the tree shares its cache scope. */
  readonly treeRootSessionId: string
  readonly runId: string
  /** Durable owner of model-visible messages appended by this run. */
  readonly turnId: string
  /** Durable id of this run's provisional assistant message. Runners mint
   * streamed message ids from it so live events and persisted history agree. */
  readonly assistantMessageId: string
  /** Ids an earlier leg of this run already minted, including ones a
   * compaction removed from `messages`. Minting must start past them. */
  readonly mintedMessageIds: ReadonlyArray<string>
  /** Model selected when this durable run started. */
  readonly model: string | null
  /** Reasoning effort selected with the pinned model. */
  readonly reasoningEffort: string | null
  /** Approval policy captured when this durable run started. */
  readonly approvalMode: ChatApprovalMode
  /** A JSON Schema the final answer must match, captured when the run started; null for none. */
  readonly outputSchema: JsonObject | null
  /** Scheduled-run identity, independent of the Chat's permanent ownership. */
  readonly automationId: AutomationId | null
  readonly messages: ReadonlyArray<ChatRunnerMessage>
  /** Drain user messages admitted while this run is active. */
  readonly getPendingMessages: () => Promise<ReadonlyArray<ChatRunnerMessage>>
  /** Check for newer conversational input without consuming its durable receipt. */
  readonly peekPendingInput: () => Promise<boolean>
  /** Resolves when a message is admitted into this run; never rejects. */
  readonly waitForPendingMessages: (signal: AbortSignal) => Promise<void>
  /** Persist a complete model history at a safe provider/tool boundary.
   * `context` carries the model-visible input size as of the latest provider
   * response; the host stores it and publishes it live so context pressure
   * updates per step instead of per run. Messages are never changed once
   * passed: the host keeps the projection of a message object it has seen,
   * and shares the previous write when nothing in the request changed. */
  readonly checkpointMessages: (
    messages: ReadonlyArray<ChatRunnerMessage>,
    context?: ChatRunnerContextReport,
    completionMessageId?: string,
    change?: HistoryChange
  ) => Promise<void>
  /** Durable provider-response usage; retries reuse the sample identity. */
  readonly recordModelUsage: (input: {
    readonly sampleId: string
    readonly usage: {
      readonly prompt: number
      readonly completion: number
      readonly total: number
      readonly cache_read: number
      readonly cache_write: number
    }
  }) => Promise<void>
  /** Execute and recover tools through the server's durable owner. */
  readonly tools: ChatRunnerTools
  readonly signal: AbortSignal
}

/** A runner may be backed by any provider. */
export type ChatRunner = (input: ChatRunnerInput) => AsyncIterable<AgentStreamEvent>

export interface ServerToolRun {
  readonly sessionId: string
  readonly runId: string
  readonly policy: RunPolicy
  readonly authority: RunAuthority
  readonly approvalMode: ChatApprovalMode
  readonly executeTool: ChatRunnerTools["execute"]
  readonly executeDetachedTool: ChatRunnerTools["executeDetached"]
  readonly spawnAgent: (request: ChatRunnerSpawnAgentRequest) => Promise<ToolResult>
  readonly cancelAgent: ChatRunnerTools["cancelAgent"]
  readonly sendMessage: (request: ChatRunnerSendMessageRequest) => Promise<ChatReceipt>
  readonly detachedRun: ChatRunnerTools["detachedRun"]
  readonly emitToolProgress: ChatRunnerTools["emitToolProgress"]
  readonly emitToolOutput: ChatRunnerTools["emitToolOutput"]
  readonly declareEffectTarget: ChatRunnerTools["declareEffectTarget"]
  readonly modelUsage?: {
    readonly admit: ChatRunnerInput["admitModelRequest"]
    readonly record: ChatRunnerInput["recordModelUsage"]
  }
  readonly imageInput?: ImageInputLimits
}
