import type { ToolDecisionFields } from "../chat/send-contracts.js"
import type { JsonObject, ToolApprovalPrompt, ToolResult } from "@arden-hq/loop"
import { Context, type Effect } from "effect"
import type { ApprovalPresentationDraft } from "./approval-draft.js"
import type { ToolExecutionStoreError } from "./store.js"

export interface DeferredToolCall {
  readonly runId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: JsonObject
  readonly changesState: boolean
  readonly data: JsonObject | undefined
  readonly grantStanding?: true
}

export type DeferredDecision =
  | { readonly kind: "not_deferred" }
  | { readonly kind: "approved"; readonly call: DeferredToolCall }
  | { readonly kind: "settled" }

export type DeferredDecisionInput = Omit<ToolDecisionFields, "toolId"> & {
  readonly toolCallId: string
}

const FOLLOW_UP_SUFFIX = ":approved"

export const deferredFollowUpId = (toolCallId: string): string => `${toolCallId}${FOLLOW_UP_SUFFIX}`

export class DeferredToolCalls extends Context.Service<
  DeferredToolCalls,
  {
    readonly defer: (input: {
      readonly call: DeferredToolCall
      readonly prompt: ToolApprovalPrompt<ApprovalPresentationDraft>
    }) => Effect.Effect<"published" | "needs_review", ToolExecutionStoreError>
    readonly decide: (
      input: DeferredDecisionInput
    ) => Effect.Effect<DeferredDecision, ToolExecutionStoreError>
    readonly approvedUnrun: () => Effect.Effect<
      ReadonlyArray<DeferredToolCall>,
      ToolExecutionStoreError
    >
    readonly rejectSidePending: () => Effect.Effect<void, ToolExecutionStoreError>
    readonly recordRun: (input: {
      readonly runId: string
      readonly toolCallId: string
      readonly result: ToolResult
    }) => Effect.Effect<void, ToolExecutionStoreError>
  }
>()("@arden-hq/server/persistence/tools/DeferredToolCalls") {}
