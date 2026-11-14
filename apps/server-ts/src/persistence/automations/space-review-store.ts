import { Context, type Effect } from "effect"
import type {
  SpaceReviewDisposition,
  SpaceReviewEvidence,
  SpaceReviewInput,
  SpaceReviewReads
} from "./space-review.js"
import type { AutomationJobLeaseRef, AutomationStoreError } from "./store.js"

export class SpaceReviewStore extends Context.Service<
  SpaceReviewStore,
  {
    readonly prepareSpaceReview: (
      lease: AutomationJobLeaseRef,
      build: (evidence: SpaceReviewEvidence) => SpaceReviewInput
    ) => Effect.Effect<SpaceReviewInput, AutomationStoreError>
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
    /** What the Space review behind this Run was given to read; undefined for any other Run. */
    readonly reviewReads: (
      runId: string
    ) => Effect.Effect<SpaceReviewReads | undefined, AutomationStoreError>
  }
>()("@arden-hq/server/persistence/automations/SpaceReviewStore") {}
