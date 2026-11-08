import type { StandingRuleList } from "@arden-hq/protocol/chat"
import type { JsonObject, ToolResult } from "@arden-hq/loop"
import type { ApprovalPresentation } from "@arden-hq/protocol/chat"
import type { PendingConnectionDecision } from "../../connections/recovery.js"
import { Context, Effect, Schema } from "effect"
import { attachMutationReceipt } from "./mutation-receipt.js"
import type { EffectTarget, EffectTargetOrigin, ToolEffect } from "../../execution/tool-effect.js"

export interface ToolExecutionIdentity {
  readonly runId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly changesState: boolean
  readonly effect?: ToolEffect
  readonly source?: string
}

export interface ToolExecutionOutcome {
  readonly status: "completed" | "uncertain"
  readonly result: ToolResult
}

export interface ToolExecutionApprovalContext {
  readonly approved: true
  readonly feedback: string | null
  readonly grantStanding?: boolean
  readonly data?: JsonObject
  readonly edited?: { readonly requested: JsonObject; readonly arguments: JsonObject }
  readonly alternative?: "draft"
}

export type ToolExecutionBeginResult =
  | { readonly _tag: "Started"; readonly approval?: ToolExecutionApprovalContext }
  | { readonly _tag: "Recovered"; readonly outcome: ToolExecutionOutcome }

export interface ToolApprovalPrompt {
  readonly reason: string
  readonly detail?: string
  readonly preview?: string
  readonly diff?: string
  readonly presentation?: ApprovalPresentation
  readonly data?: JsonObject
}

export interface ResolveToolApprovalInput {
  readonly runId: string
  readonly toolCallId: string
  readonly approved?: boolean
  readonly feedback?: string
  readonly grantStanding?: boolean
  readonly grantList?: StandingRuleList
  readonly attachFolderToSpace?: boolean
  readonly edits?: ApprovalEditsInput
  readonly alternative?: ApprovalAlternativeInput
}

export interface ApprovalAlternativeInput {
  readonly kind: "draft"
  readonly offeredBy: (toolName: string) => boolean
}

export type ApprovalEditOutcome =
  | { readonly _tag: "Edited"; readonly arguments: JsonObject }
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Refused"; readonly reason: string }

export interface ApprovalEditsInput {
  readonly patch: JsonObject
  readonly apply: (call: {
    readonly toolName: string
    readonly requested: JsonObject
    readonly patch: JsonObject
  }) => ApprovalEditOutcome
}

export interface ResolveToolApprovalResult {
  readonly runId: string
  readonly ready: boolean
}

export class ToolExecutionStoreError extends Schema.TaggedError<ToolExecutionStoreError>()(
  "ToolExecutionStoreError",
  {
    operation: Schema.Literals([
      "begin",
      "complete",
      "pause",
      "uncertain",
      "target",
      "require_outcome_decision",
      "recover",
      "resolve",
      "history",
      "pending_approvals",
      "pending_connections"
    ] as const),
    reason: Schema.Literals([
      "invalid",
      "not_found",
      "conflict",
      "blocked",
      "corrupt",
      "storage"
    ] as const),
    message: Schema.String,
    runId: Schema.optionalKey(Schema.NonEmptyString),
    toolCallId: Schema.optionalKey(Schema.NonEmptyString),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const TOOL_OUTCOME_UNCERTAIN = "tool_outcome_uncertain"
export const TOOL_PERSISTENCE_FAILED = "tool_persistence_failed"
export const TOOL_MUTATION_STALLED = "tool_mutation_stalled"

export type MutationBlocker = "decision_required" | "awaiting_approval" | "stalled"

const feedbackSuffix = (feedback: string | null): string =>
  feedback === null ? "" : ` Feedback: ${feedback}`

export const UNCERTAIN_TOOL_RESULT = Object.freeze({
  content:
    "This tool call was running when the process stopped, so it may or may not have taken effect. Check the current state first. If the effect is already there, continue from it; only repeat the call if it is missing.",
  preview: "Tool execution outcome is uncertain",
  is_error: true,
  retryable: false,
  data: Object.freeze({ outcome: "uncertain" }),
  message_extras: Object.freeze({}),
  host: Object.freeze({}),
  model_content: Object.freeze([])
} satisfies ToolResult)

export const RejectedToolResultSchema = Schema.Struct({
  data: Schema.Struct({
    approval: Schema.Struct({
      by: Schema.Literal("user"),
      decision: Schema.Literal("rejected"),
      feedback: Schema.optionalKey(Schema.String)
    })
  })
})

export const rejectedToolResult = (
  identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">,
  feedback: string | null
): ToolResult =>
  attachMutationReceipt(
    {
      content: `The user rejected this tool execution.${feedbackSuffix(feedback)}`,
      preview: "Tool execution rejected",
      is_error: true,
      retryable: false,
      data: {
        approval: { by: "user", decision: "rejected", ...(feedback === null ? {} : { feedback }) }
      }
    },
    {
      identity,
      outcome: "no_op",
      resource: { kind: "none" }
    }
  )

export const confirmedToolOutcomeResult = (
  identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">,
  completed: boolean,
  feedback: string | null
): ToolResult =>
  attachMutationReceipt(
    completed
      ? {
          content: `The user confirmed that this tool execution completed.${feedbackSuffix(feedback)}`,
          preview: "Tool execution confirmed",
          retryable: false,
          data: { outcome: "confirmed_completed" }
        }
      : {
          content: `The user confirmed that this tool execution did not complete.${feedbackSuffix(feedback)}`,
          preview: "Tool execution did not complete",
          is_error: true,
          retryable: false,
          data: { outcome: "confirmed_not_completed" }
        },
    {
      identity,
      outcome: completed ? "applied" : "no_op",
      resource: { kind: "none" }
    }
  )

export class ToolExecutionStore extends Context.Service<
  ToolExecutionStore,
  {
    readonly begin: (
      identity: ToolExecutionIdentity,
      options?: {
        readonly backgrounded?: ReadonlySet<string>
      }
    ) => Effect.Effect<ToolExecutionBeginResult, ToolExecutionStoreError>
    readonly complete: (
      identity: ToolExecutionIdentity,
      result: ToolResult
    ) => Effect.Effect<ToolResult, ToolExecutionStoreError>
    readonly pause: (
      identity: ToolExecutionIdentity,
      prompt: ToolApprovalPrompt
    ) => Effect.Effect<void, ToolExecutionStoreError>
    readonly suspend: (
      identity: ToolExecutionIdentity,
      nestedToolCallId: string
    ) => Effect.Effect<void, ToolExecutionStoreError>
    readonly uncertain: (
      identity: ToolExecutionIdentity
    ) => Effect.Effect<ToolResult, ToolExecutionStoreError>
    readonly target: (input: {
      readonly runId: string
      readonly toolCallId: string
      readonly target: EffectTarget
      readonly origin: EffectTargetOrigin
    }) => Effect.Effect<void, ToolExecutionStoreError>
    readonly requireOutcomeDecision: (
      input: Pick<ToolExecutionIdentity, "runId" | "sessionId">
    ) => Effect.Effect<MutationBlocker, ToolExecutionStoreError>
    readonly recover: (
      identities: ReadonlyArray<ToolExecutionIdentity>
    ) => Effect.Effect<ReadonlyMap<string, ToolExecutionOutcome>, ToolExecutionStoreError>
    readonly runningCount: (
      runIds: ReadonlyArray<string>
    ) => Effect.Effect<number, ToolExecutionStoreError>
    readonly resolve: (
      input: ResolveToolApprovalInput
    ) => Effect.Effect<ResolveToolApprovalResult, ToolExecutionStoreError>
    readonly priorResults: (input: {
      readonly sessionId: string
      readonly toolName: string
    }) => Effect.Effect<
      ReadonlyArray<{ readonly runId: string; readonly data: Readonly<Record<string, unknown>> }>,
      ToolExecutionStoreError
    >
    readonly pendingConnection: (
      input: Pick<ToolExecutionIdentity, "runId" | "toolCallId">
    ) => Effect.Effect<PendingConnectionDecision | null, ToolExecutionStoreError>
    readonly allPendingConnections: () => Effect.Effect<
      ReadonlyArray<PendingConnectionDecision>,
      ToolExecutionStoreError
    >
  }
>()("@arden-hq/server/persistence/tools/ToolExecutionStore") {}
