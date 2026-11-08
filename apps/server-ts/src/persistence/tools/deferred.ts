import type { JsonObject, ToolApprovalPrompt, ToolResult } from "@arden-hq/loop"
import { Context, type Effect } from "effect"
import type { ApprovalPresentation } from "@arden-hq/protocol/chat"
import type { ToolResultInput } from "@arden-hq/protocol/chat"
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

export type DeferredDecisionInput = Omit<ToolResultInput, "toolId"> & {
  readonly toolCallId: string
}

const FOLLOW_UP_SUFFIX = ":approved"

export const deferredFollowUpId = (toolCallId: string): string => `${toolCallId}${FOLLOW_UP_SUFFIX}`

export const deferredCallOf = (toolCallId: string): string | undefined =>
  toolCallId.endsWith(FOLLOW_UP_SUFFIX) && toolCallId.length > FOLLOW_UP_SUFFIX.length
    ? toolCallId.slice(0, -FOLLOW_UP_SUFFIX.length)
    : undefined

export class DeferredToolCalls extends Context.Service<
  DeferredToolCalls,
  {
    readonly defer: (input: {
      readonly call: DeferredToolCall
      readonly prompt: ToolApprovalPrompt<ApprovalPresentation>
    }) => Effect.Effect<void, ToolExecutionStoreError>
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
