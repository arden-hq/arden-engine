import { storeReasons } from "../errors.js"
import { Context, Effect, Schema } from "effect"
import type { ApprovalMode } from "@arden-hq/protocol/permissions"
import type { RunCapability } from "../../execution/policy.js"
import type { RunAuthority } from "../../execution/authority.js"
import type { AskReason } from "../../execution/decide.js"
import type { ReviewAssessment, ReviewEnding, ReviewJudgement } from "../../execution/review.js"

import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import type { SessionPermission } from "@arden-hq/protocol/permissions"
export { ApprovalModeSchema }
export type { SessionPermission }

export interface AuthorityLiveState {
  readonly state: "active" | "settling" | "revoked"
  readonly mode: ApprovalMode
  readonly noApproval: boolean
  readonly currentScope: RunCapability | undefined
}

export interface ApprovalReviewRecord {
  readonly runId: string
  readonly toolCallId: string
  readonly sessionId: string
  readonly toolName: string
  readonly rung: AskReason
  readonly modelId: string | undefined
  readonly outcome:
    | (ReviewJudgement & { readonly assessment: ReviewAssessment })
    | { readonly decision: "ask"; readonly decided_by: "timed_out" | "failed" | "stopped" }
}

export class ApprovalPolicyError extends Schema.TaggedError<ApprovalPolicyError>()(
  "ApprovalPolicyError",
  {
    reason: storeReasons(["not_found", "invalid", "conflict", "storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class ApprovalPolicyStore extends Context.Service<
  ApprovalPolicyStore,
  {
    readonly session: (sessionId: string) => Effect.Effect<SessionPermission, ApprovalPolicyError>
    readonly setSession: (input: {
      readonly sessionId: string
      readonly mode?: typeof ApprovalModeSchema.Type
    }) => Effect.Effect<SessionPermission, ApprovalPolicyError>
    readonly defaultMode: () => Effect.Effect<ApprovalMode, ApprovalPolicyError>
    readonly setDefaultMode: (
      mode: ApprovalMode
    ) => Effect.Effect<ApprovalMode, ApprovalPolicyError>
    readonly live: (input: {
      readonly runId: string
      readonly authority: RunAuthority
    }) => Effect.Effect<AuthorityLiveState, ApprovalPolicyError>
    readonly refusedCalls: (input: {
      readonly runId: string
      readonly toolName: string
    }) => Effect.Effect<number, ApprovalPolicyError>
    readonly reviewEndings: (
      runId: string
    ) => Effect.Effect<ReadonlyArray<ReviewEnding>, ApprovalPolicyError>
    readonly recordReview: (
      record: ApprovalReviewRecord
    ) => Effect.Effect<void, ApprovalPolicyError>
  }
>()("@arden-hq/server/persistence/permissions/ApprovalPolicyStore") {}
