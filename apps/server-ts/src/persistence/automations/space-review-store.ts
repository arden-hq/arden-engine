import { Context, type Effect } from "effect"
import type {
  ChangedChatTurn,
  SpaceReviewDisposition,
  SpaceReviewEvidence,
  SpaceReviewGateEvidence,
  SpaceReviewInput
} from "./space-review.js"
import type { AutomationJobLeaseRef, AutomationStoreError } from "./store.js"

export class SpaceReviewStore extends Context.Service<
  SpaceReviewStore,
  {
    readonly prepareSpaceReview: (
      lease: AutomationJobLeaseRef,
      build: (evidence: SpaceReviewEvidence) => SpaceReviewInput
    ) => Effect.Effect<SpaceReviewInput | null, AutomationStoreError>
    readonly readSpaceReviewGateEvidence: (
      lease: AutomationJobLeaseRef,
      turns: ReadonlyArray<ChangedChatTurn>
    ) => Effect.Effect<SpaceReviewGateEvidence, AutomationStoreError>
    readonly holdSpaceReview: (
      lease: AutomationJobLeaseRef,
      until: string
    ) => Effect.Effect<void, AutomationStoreError>
    readonly validateSpaceReviewDisposition: (
      runId: string,
      disposition: SpaceReviewDisposition
    ) => Effect.Effect<void, AutomationStoreError>
    readonly completeSpaceReview: (
      lease: AutomationJobLeaseRef,
      runId: string
    ) => Effect.Effect<SpaceReviewDisposition, AutomationStoreError>
    readonly requestProposalReview: (input: {
      readonly proposalId: string
      readonly expectedRevision: number
    }) => Effect.Effect<void, AutomationStoreError>
    readonly proposalReviewStatus: (input: { readonly proposalId: string }) => Effect.Effect<
      | {
          readonly expectedRevision: number
          readonly state: "queued" | "running" | "completed" | "failed"
          readonly message: string
        }
      | undefined,
      AutomationStoreError
    >
  }
>()("@arden-hq/server/persistence/automations/SpaceReviewStore") {}
