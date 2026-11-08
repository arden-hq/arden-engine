import { Effect } from "effect"
import type {
  AutomationJobLease,
  AutomationJobSettlement
} from "../persistence/automations/store.js"
import type { SpaceReviewStore } from "../persistence/automations/space-review-store.js"
import type { Wiki } from "../wiki/service.js"
import type { SpaceReviewInput } from "../persistence/automations/space-review.js"
import { buildSpaceReviewInput } from "./space-review-input.js"
import { renderProposalRecheckPrompt } from "../prompts/space-jobs.js"
import type { SpaceReviewHold } from "./space-review-gate.js"
import { jobResult } from "./runner.js"

export const makeSpaceReviewRunner = (services: {
  readonly wiki: Pick<Wiki["Service"], "snapshot">
  readonly spaceReviews: Pick<
    SpaceReviewStore["Service"],
    "prepareSpaceReview" | "completeSpaceReview" | "holdSpaceReview"
  >
  readonly screen: (
    job: AutomationJobLease,
    input: SpaceReviewInput
  ) => Effect.Effect<SpaceReviewHold | undefined>
  readonly execute: (job: AutomationJobLease) => Effect.Effect<AutomationJobSettlement, Error>
}): ((job: AutomationJobLease) => Effect.Effect<AutomationJobSettlement, Error>) =>
  Effect.fn("SpaceReviewRunner")(function* (
    job: AutomationJobLease
  ): Effect.fn.Return<AutomationJobSettlement, Error> {
    const { payload } = job
    if (payload.handler !== null) throw new Error("A Space review job has no system handler")
    const input =
      payload.proposalReviewTarget === undefined && payload.spaceReviewInput !== undefined
        ? payload.spaceReviewInput
        : yield* services.spaceReviews.prepareSpaceReview(
            job,
            buildSpaceReviewInput(yield* services.wiki.snapshot())
          )
    if (input === null || input.admission === "unchanged")
      return jobResult.withoutRun("no_change", "Space evidence is unchanged.")
    const hold = yield* services.screen(job, input)
    if (hold !== undefined) {
      yield* services.spaceReviews.holdSpaceReview(job, hold.until)
      return { status: "skipped", skip: hold.skip }
    }
    const result = yield* services.execute({
      ...job,
      payload: {
        ...payload,
        prompt:
          payload.proposalReviewTarget === undefined
            ? input.prompt
            : `${input.prompt}\n\n${renderProposalRecheckPrompt(payload.proposalReviewTarget.proposalId, payload.proposalReviewTarget.expectedRevision)}`,
        spaceReviewInput: input
      }
    })
    if (result.status !== "ended" || result.chatRunId === null) return result
    if (result.outcome === "blocked") return { ...result, outcome: "failed" }
    if (result.outcome !== "finished") return result
    const completion = yield* services.spaceReviews.completeSpaceReview(job, result.chatRunId).pipe(
      Effect.match({
        onFailure: (error) => ({ kind: "failure" as const, error }),
        onSuccess: (disposition) => ({ kind: "success" as const, disposition })
      })
    )
    if (completion.kind === "failure") {
      if (completion.error.reason !== "invalid") return yield* completion.error
      return { ...result, outcome: "failed", error: completion.error.message }
    }
    switch (completion.disposition.kind) {
      case "needs_user":
        return { ...result, outcome: "needs_you" }
      case "no_change":
        return { ...result, outcome: "no_change" }
      case "changed":
      case "reconciled":
      case "proposed":
        return { ...result, outcome: "finished" }
    }
  })
