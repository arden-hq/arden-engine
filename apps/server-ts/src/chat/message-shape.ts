import type { CancelResponse, ChatAcknowledgement } from "@arden-hq/protocol/chat"
import type { Effect, Exit, Stream } from "effect"
import type {
  ChatSendReceipt,
  RunCancelTarget,
  ToolDecisionFields
} from "../persistence/chat/send-contracts.js"
import type { ApprovalAlternativeInput, ApprovalEditsInput } from "../persistence/tools/store.js"
import type { ChatMessageError, ChatMessageFailure } from "./message-errors.js"
import type { ChatAutomationStartInput, ChatSendInput } from "./message-input.js"
import type { TaskContinuationInput } from "./run-driver-support.js"
import type { ServerToolRun } from "./runner-contract.js"

export interface ChatMessageShape {
  readonly runnerAvailability: Stream.Stream<boolean>
  readonly send: (input: ChatSendInput) => Effect.Effect<ChatSendReceipt, ChatMessageFailure>
  readonly sendTogether: (
    inputs: ReadonlyArray<ChatSendInput>
  ) => Effect.Effect<ReadonlyArray<Exit.Exit<ChatSendReceipt, ChatMessageFailure>>>
  readonly startAutomation: (
    input: ChatAutomationStartInput
  ) => Effect.Effect<ChatSendReceipt, ChatMessageFailure>
  readonly cancel: (input: RunCancelTarget) => Effect.Effect<CancelResponse, ChatMessageFailure>
  readonly stopRuns: (runIds: ReadonlyArray<string>) => Effect.Effect<void, ChatMessageFailure>
  readonly resolveTool: (
    input: Omit<ToolDecisionFields, "alternative"> & {
      readonly edits?: ApprovalEditsInput
      readonly alternative?: ApprovalAlternativeInput
    }
  ) => Effect.Effect<ChatAcknowledgement, ChatMessageFailure>
  readonly continueTask: (input: TaskContinuationInput) => Effect.Effect<void>
  readonly detachedRun: (input: {
    readonly sessionId: string
    readonly runId: string
  }) => Effect.Effect<ServerToolRun, ChatMessageError>
  readonly drain: (input: {
    readonly toolSettleMs: number
    readonly budgetMs?: number
    readonly reason: StopReason
  }) => Effect.Effect<void>
}

export type StopReason = "quit" | "restart"
