import type { TaskProposalReview } from "@arden-hq/protocol/proposals"
import { Effect, Result } from "effect"
import type { SpaceReviewStore } from "../automations/space-review-store.js"
import { TaskProposalStore, TaskProposalStoreError } from "../proposals/store.js"
import { TaskProposalConflictError } from "../proposals/conflict.js"

const conflict = (
  kind: ConstructorParameters<typeof TaskProposalConflictError>[0]["kind"],
  message: string
) => new TaskProposalConflictError({ kind, message })

const unavailable = (message: string) => new TaskProposalStoreError({ reason: "storage", message })

const currentOfferMessage = (message: string, proposal: TaskProposalReview["proposal"]): string => {
  switch (proposal.status) {
    case "retired":
      return "The review retired this offer based on evidence; it is no longer available to accept."
    case "accepted":
      return "This offer was accepted while the review was running. The current proposal shows the settled Task."
    case "rejected":
      return "This offer was rejected while the review was running."
    case "offered":
      return message
    case "held":
      return "The current proposal is held and cannot be accepted until it is offered again."
  }
}

export const withTaskProposalReview = (
  proposals: Omit<TaskProposalStore["Service"], "requestProposalReview" | "proposalReviewStatus">,
  reviews: SpaceReviewStore["Service"]
): TaskProposalStore["Service"] =>
  TaskProposalStore.of({
    ...proposals,
    requestProposalReview: Effect.fn("TaskProposal.requestReview")(function* ({
      proposalId,
      expectedRevision
    }): Effect.fn.Return<TaskProposalReview, TaskProposalStoreError | TaskProposalConflictError> {
      const proposal = yield* proposals.get(proposalId)
      if (proposal === undefined)
        return yield* Effect.fail(
          new TaskProposalStoreError({ reason: "not_found", message: "Task proposal not found" })
        )
      if (proposal.status !== "offered")
        return yield* Effect.fail(
          conflict(
            proposal.status === "accepted" ||
              proposal.status === "rejected" ||
              proposal.status === "retired"
              ? "settled"
              : "not_offered",
            "Only an offered Task proposal can be rechecked"
          )
        )
      if (proposal.revision !== expectedRevision)
        return yield* Effect.fail(conflict("proposal_changed", "The Task proposal changed"))
      if (proposal.place !== "space" || proposal.space_id === null)
        return yield* Effect.fail(
          conflict("not_offered", "This proposal is not offered on a Space")
        )

      const queued = yield* Effect.result(
        reviews.requestProposalReview({ proposalId, expectedRevision })
      )
      if (Result.isFailure(queued)) {
        const error = queued.failure
        if (error.reason !== "conflict") return yield* Effect.fail(unavailable(error.message))
        const current = yield* proposals.get(proposalId)
        if (current === undefined || current.status !== "offered")
          return yield* Effect.fail(conflict("settled", "The Task proposal is no longer offered"))
        if (current.revision !== expectedRevision)
          return yield* Effect.fail(conflict("proposal_changed", "The Task proposal changed"))
        return yield* Effect.fail(conflict("space_unavailable", error.message))
      }
      const latest = yield* proposals.get(proposalId)
      if (latest === undefined)
        return yield* Effect.fail(conflict("settled", "The Task proposal is no longer available"))
      const status = yield* reviews
        .proposalReviewStatus({ proposalId })
        .pipe(Effect.mapError((error) => unavailable(error.message)))
      if (status === undefined)
        return yield* Effect.fail(unavailable("The queued Task proposal review could not be read"))
      return {
        expected_revision: status.expectedRevision,
        state: status.state,
        message: currentOfferMessage(status.message, latest),
        proposal: latest
      }
    }),
    proposalReviewStatus: Effect.fn("TaskProposal.reviewStatus")(function* ({ proposalId }) {
      const proposal = yield* proposals.get(proposalId)
      if (proposal === undefined) return undefined
      const status = yield* reviews
        .proposalReviewStatus({ proposalId })
        .pipe(Effect.mapError((error) => unavailable(error.message)))
      return status === undefined
        ? undefined
        : {
            expected_revision: status.expectedRevision,
            state: status.state,
            message: currentOfferMessage(status.message, proposal),
            proposal
          }
    })
  })
