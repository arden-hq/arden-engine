import type { ChatSendReceipt } from "../persistence/chat/send-contracts.js"
import type { ChatApprovalMode, ChatImageInput } from "@arden-hq/protocol/chat"
import type { StoredInteractionSender } from "../persistence/transcript/interaction.js"
import type { ModelPhaseTiming } from "@arden-hq/protocol/daemon"
import type {
  AgentStreamEvent,
  ChatMessage,
  HeldToolCall,
  ImageInput,
  JsonObject,
  ToolResult
} from "@arden-hq/loop"
import type { HistoryChange } from "@arden-hq/loop"
import type { StoredRunUsage as RunUsage } from "../persistence/runs/stored-result.js"
import type { RunPolicy } from "../execution/policy.js"
import type { RunAuthority } from "../execution/authority.js"
import type { EffectTarget, EffectTargetOrigin, ToolEffect } from "../execution/tool-effect.js"
import type { CodeAgentWorkspace } from "../sessions/agent-mode.js"
import type { AutomationId } from "../persistence/automations/model.js"
import type { ToolCallPlan } from "../persistence/work/task-direction.js"

export type ChatRunnerMessage = ChatMessage

export interface ChatRunnerToolRequest {
  readonly toolCallId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly changesState: boolean
  readonly effect?: ToolEffect
  readonly source?: string
  readonly plan?: ToolCallPlan
}

interface ChatRunnerSpawnAgentRequestBase {
  readonly toolCallId: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly task: string
  readonly name?: string
  readonly taskItemId?: string
  readonly outputSchema?: JsonObject
  readonly model?: string
  readonly reasoningEffort?: string
  readonly defaultModel?: { readonly model: string; readonly reasoningEffort: string | null }
  readonly forkHistory?: ReadonlyArray<ChatRunnerMessage>
}

export type ChatRunnerSpawnAgentRequest =
  | (ChatRunnerSpawnAgentRequestBase & { readonly mode: "research" | "work" })
  | (ChatRunnerSpawnAgentRequestBase & {
      readonly mode: "code"
      readonly requestedWorkingDirectory?: string
      readonly workspace: CodeAgentWorkspace
    })

export interface ChatRunnerSendMessageRequest {
  readonly wake?: boolean
  readonly sessionId: string
  readonly clientId: string
  readonly message: string
  readonly images?: ReadonlyArray<ChatImageInput>
  readonly sender?: StoredInteractionSender
  readonly announce?: true
  readonly fromChat?: { readonly sessionId: string; readonly sessionRef: string }
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

export interface ChatRunnerToolOperationContext {
  readonly approval?: {
    readonly approved: true
    readonly feedback: string | null
    readonly data?: JsonObject
  }
  readonly admit: () => Promise<ToolResult | undefined>
}

export interface ChatRunnerTools {
  readonly execute: (
    request: ChatRunnerToolRequest,
    operation: (context?: ChatRunnerToolOperationContext) => ToolResult | PromiseLike<ToolResult>,
    options?: {
      readonly backgrounded?: Promise<void>
    }
  ) => Promise<ToolResult>
  readonly executeDetached: (
    request: ChatRunnerToolRequest,
    operation: (context?: ChatRunnerToolOperationContext) => ToolResult | PromiseLike<ToolResult>
  ) => Promise<ToolResult>
  readonly holdBackground: (calls: ReadonlyArray<HeldToolCall>) => void
  readonly claimBackground: (
    toolCallIds: ReadonlyArray<string>
  ) => ReadonlyMap<string, HeldToolCall>
  readonly recover: (
    calls: ReadonlyArray<ChatRunnerToolRequest>
  ) => Promise<ReadonlyMap<string, ToolResult>>
  readonly spawnAgent: (request: ChatRunnerSpawnAgentRequest) => Promise<ToolResult>
  readonly cancelAgent: (input: { readonly runId: string }) => Promise<void>
  readonly sendMessage: (request: ChatRunnerSendMessageRequest) => Promise<ChatSendReceipt>
  readonly detachedRun: (input: {
    readonly sessionId: string
    readonly runId: string
  }) => Promise<ServerToolRun>
  readonly emitToolProgress: (request: ChatRunnerToolProgressRequest) => Promise<void>
  readonly emitToolOutput: (request: ChatRunnerToolOutputRequest) => Promise<void>
  readonly declareEffectTarget: (request: {
    readonly toolCallId: string
    readonly target: EffectTarget
    readonly origin: EffectTargetOrigin
  }) => Promise<void>
}

export interface ChatRunnerContextReport {
  readonly inputTokens: number
  readonly usage: {
    readonly prompt: number
    readonly completion: number
    readonly cache_read: number
    readonly cache_write: number
  }
}

export interface ChatRunnerInput {
  readonly reportModelTiming?: (timing: ModelPhaseTiming) => void
  readonly executionBudget: () => Promise<{ readonly remainingTokens: number | null }>
  readonly admitModelRequest: (sampleId: string) => Promise<void>
  readonly sessionId: string
  readonly treeRootSessionId: string
  readonly runId: string
  readonly turnId: string
  readonly assistantMessageId: string
  readonly mintedMessageIds: ReadonlyArray<string>
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly approvalMode: ChatApprovalMode
  readonly outputSchema: JsonObject | null
  readonly automationId: AutomationId | null
  readonly messages: ReadonlyArray<ChatRunnerMessage>
  readonly getPendingMessages: () => Promise<ReadonlyArray<ChatRunnerMessage>>
  readonly peekPendingInput: () => Promise<boolean>
  readonly waitForPendingMessages: (signal: AbortSignal) => Promise<void>
  readonly checkpointMessages: (
    messages: ReadonlyArray<ChatRunnerMessage>,
    context?: ChatRunnerContextReport,
    completionMessageId?: string,
    change?: HistoryChange
  ) => Promise<void>
  readonly recordModelUsage: (input: {
    readonly sampleId: string
    readonly usage: RunUsage
  }) => Promise<void>
  readonly tools: ChatRunnerTools
  readonly signal: AbortSignal
}

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
  readonly sendMessage: (request: ChatRunnerSendMessageRequest) => Promise<ChatSendReceipt>
  readonly detachedRun: ChatRunnerTools["detachedRun"]
  readonly emitToolProgress: ChatRunnerTools["emitToolProgress"]
  readonly emitToolOutput: ChatRunnerTools["emitToolOutput"]
  readonly declareEffectTarget: ChatRunnerTools["declareEffectTarget"]
  readonly modelUsage?: {
    readonly admit: ChatRunnerInput["admitModelRequest"]
    readonly record: ChatRunnerInput["recordModelUsage"]
  }
  readonly imageInput?: ImageInput
}
