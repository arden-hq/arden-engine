import type {
  AgentConfigInput,
  AgentHooks,
  AgentOptions,
  AgentOutputOptions,
  ImageInput,
  ModelProvider,
  Toolset
} from "@arden-hq/loop"
import type { ChatRunnerInput, ChatRunnerMessage, ServerToolRun } from "./runner-contract.js"
import { type CompletedModelRequest } from "./request-observation.js"
import {
  type LocalInstructionLoader,
  type LocalInstructionRecorder
} from "./local-instruction-runtime.js"
import type { AutomationId } from "../persistence/automations/model.js"
import { type OrphanToolOutput } from "./tool-history-repair.js"
import { type RuntimeContext } from "../context/runtime-update.js"
import type { ModelDefinition } from "../models/host.js"

type LoopChatRunnerAgentOptions = Omit<AgentOptions, "provider" | "toolset" | "hooks"> & {
  readonly hooks?: Omit<
    AgentHooks,
    "getPendingMessages" | "hasPendingInput" | "waitForPendingMessages" | "recoverToolCalls"
  >
}

export const LOOP_COMPACTION_RESULT = {
  unchanged: "unchanged",
  replacement: "replacement",
  disabledForRun: "disabled_for_run"
} as const

export type LoopChatCompactionResult =
  | { readonly kind: typeof LOOP_COMPACTION_RESULT.unchanged }
  | {
      readonly kind: typeof LOOP_COMPACTION_RESULT.replacement
      readonly messages: ReadonlyArray<ChatRunnerMessage>
    }
  | { readonly kind: typeof LOOP_COMPACTION_RESULT.disabledForRun }

export interface LoopChatRunnerOptions {
  readonly provider: ModelProvider
  readonly onRequestComplete?: (input: CompletedModelRequest) => void
  readonly toolset:
    | Toolset
    | ((input: {
        readonly sessionId: string
        readonly runId: string
        readonly approvalMode: ChatRunnerInput["approvalMode"]
        readonly automationId: AutomationId | null
        readonly executeTool: ChatRunnerInput["tools"]["execute"]
        readonly executeDetachedTool: ChatRunnerInput["tools"]["executeDetached"]
        readonly spawnAgent: ChatRunnerInput["tools"]["spawnAgent"]
        readonly cancelAgent: ChatRunnerInput["tools"]["cancelAgent"]
        readonly sendMessage: ChatRunnerInput["tools"]["sendMessage"]
        readonly detachedRun: ChatRunnerInput["tools"]["detachedRun"]
        readonly emitToolProgress: ChatRunnerInput["tools"]["emitToolProgress"]
        readonly emitToolOutput: ChatRunnerInput["tools"]["emitToolOutput"]
        readonly declareEffectTarget: ChatRunnerInput["tools"]["declareEffectTarget"]
        readonly modelUsage: NonNullable<ServerToolRun["modelUsage"]>
        readonly imageInput?: ImageInput
      }) => Toolset | PromiseLike<Toolset>)
  readonly config?: Omit<
    AgentConfigInput,
    "model" | "reasoningEffort" | "toolCallMiddlewares" | "mintMessageId"
  >
  readonly systemPrompt?: string | (() => string | PromiseLike<string>)
  readonly localTime?: () => string
  readonly todoReminder?: (input: {
    readonly sessionId: string
    readonly signal: AbortSignal
  }) => PromiseLike<string | undefined>
  readonly ownerWords?: (input: {
    readonly sessionId: string
    readonly messageIds: ReadonlyArray<string>
    readonly signal: AbortSignal
  }) => PromiseLike<ReadonlySet<string>>
  readonly systemContext?: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly automationId: AutomationId | null
    readonly messages: ReadonlyArray<ChatRunnerMessage>
    readonly signal: AbortSignal
  }) => PromiseLike<RuntimeContext | undefined>
  readonly localInstructions?: LocalInstructionLoader
  readonly recordLocalInstructions?: LocalInstructionRecorder
  readonly localInstructionDirectories?: ReadonlyArray<string>
  readonly output?: (input: ChatRunnerInput) => Promise<AgentOutputOptions | undefined>
  readonly preloadTools?: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly automationId: AutomationId | null
  }) => PromiseLike<ReadonlyArray<string>>
  readonly agentOptions?: LoopChatRunnerAgentOptions
  readonly modelContext?: (model: string) => ModelDefinition["context"] | undefined
  readonly onOrphanToolOutputs?: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly orphans: ReadonlyArray<OrphanToolOutput>
  }) => void
  readonly compact?: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly model: string
    readonly reasoningEffort: string | null
    readonly messages: ReadonlyArray<ChatRunnerMessage>
    readonly inputTokens: number | null
    readonly overflow: boolean
    readonly pendingCallIds: ReadonlySet<string>
    readonly signal: AbortSignal
  }) => PromiseLike<LoopChatCompactionResult>
}
