import { Clock, Duration, Effect } from "effect"
import type { Decisions } from "../models/decisions/service.js"
import type { DecisionQuestion } from "../models/decisions/questions.js"
import type { SpaceReviewInput } from "../persistence/automations/space-review.js"
import type { SpaceReviewStore } from "../persistence/automations/space-review-store.js"
import type { AutomationJobLease, SpaceReviewGateSkip } from "../persistence/automations/store.js"
import { iso } from "../runtime/clock.js"
import { spaceReviewGateText } from "./space-review-gate-input.js"

const MAX_HOLD = Duration.hours(4)

export interface SpaceReviewHold {
  readonly skip: SpaceReviewGateSkip
  readonly until: string
}

const GATE_QUESTION = {
  kind: "choice",
  instructions:
    "A review run would read this Space's new evidence and its open Tasks. Will the run change anything: a comment or update on a Task, a new Task proposal, or a question for the person? Most reviews change nothing. Choose 'changes' only if the new evidence clearly concerns an open Task or holds a distinct new outcome; choose 'nothing' if it is routine, unrelated or already covered.",
  options: [
    { value: "nothing", description: "The review finds nothing to do and ends with no change." },
    {
      value: "changes",
      description: "The review changes a Task, proposes a Task, or asks the person a question."
    }
  ]
} as const satisfies DecisionQuestion

export const screenSpaceReview = (services: {
  readonly decisions: Pick<Decisions["Service"], "decide">
  readonly spaceReviews: Pick<SpaceReviewStore["Service"], "readSpaceReviewGateEvidence">
}): ((
  job: AutomationJobLease,
  input: SpaceReviewInput
) => Effect.Effect<SpaceReviewHold | undefined>) =>
  Effect.fn("SpaceReview.screen")(function* (job: AutomationJobLease, input: SpaceReviewInput) {
    const reads = input.reads
    if (
      job.payload.occurrence === "manual" ||
      job.payload.proposalReviewTarget !== undefined ||
      reads === undefined
    )
      return undefined
    const now = yield* Clock.currentTimeMillis
    const evidence = yield* services.spaceReviews
      .readSpaceReviewGateEvidence(job, reads.chats)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("The Space review gate could not read its evidence; the review runs", {
            automation_id: job.payload.automationId,
            message: error.message
          }).pipe(Effect.as(undefined))
        )
      )
    if (evidence === undefined) return undefined
    const heldSince = evidence.heldSince === undefined ? now : Date.parse(evidence.heldSince)
    const until = heldSince + Duration.toMillis(MAX_HOLD)
    if (until <= now) return undefined
    const decided = yield* services.decisions.decide({
      site: "space_review_gate",
      question: GATE_QUESTION,
      state: { space_review_input: spaceReviewGateText(reads, evidence) },
      default: "changes"
    })
    if (decided.by !== "decision_model" || decided.value !== "nothing") return undefined
    return {
      skip: { reason: "space_review_gate", backend: decided.backend, nothing: decided.probability },
      until: iso(until)
    }
  })
