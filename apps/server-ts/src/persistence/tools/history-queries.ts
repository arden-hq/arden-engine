import type { JsonObject } from "@arden-hq/loop"
import type { RuntimeApprovalSnapshot } from "@arden-hq/protocol/chat"
import { Context, type Effect } from "effect"
import type { PendingConnectionDecision } from "../../connections/recovery.js"
import type { ToolExecutionStoreError } from "./store.js"

export interface ToolExecutionResultMetadata {
  readonly isError: boolean
  readonly retryable: boolean | null
  readonly data?: JsonObject
  readonly durationMs?: number
}

export interface ToolExecutionHistoryInput {
  readonly sessionId: string
  readonly toolCallIds: ReadonlyArray<string>
}

export interface LedgerToolCallInput {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
}

export interface LedgerToolCall {
  readonly name: string
  readonly arguments: string
  readonly result: string | undefined
  readonly isError: boolean
}

export interface AgentAssignment {
  readonly fromSessionRef: string
  readonly toSessionRef: string
  readonly toolCallId: string
  readonly task: string
}

export class ToolHistoryQueries extends Context.Service<
  ToolHistoryQueries,
  {
    readonly agentAssignment: (
      sessionId: string
    ) => Effect.Effect<AgentAssignment | undefined, ToolExecutionStoreError>
    readonly historyResultMetadata: (
      input: ToolExecutionHistoryInput
    ) => Effect.Effect<ReadonlyMap<string, ToolExecutionResultMetadata>, ToolExecutionStoreError>
    readonly ledgerToolCall: (
      input: LedgerToolCallInput
    ) => Effect.Effect<LedgerToolCall | undefined, ToolExecutionStoreError>
    readonly pendingApprovals: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<RuntimeApprovalSnapshot>, ToolExecutionStoreError>
    readonly pendingDescendantApprovals: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<RuntimeApprovalSnapshot>, ToolExecutionStoreError>
    readonly pendingConnections: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<PendingConnectionDecision>, ToolExecutionStoreError>
    readonly pendingDescendantConnections: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<PendingConnectionDecision>, ToolExecutionStoreError>
  }
>()("@arden-hq/server/persistence/tools/ToolHistoryQueries") {}
