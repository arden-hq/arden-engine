import type { JsonObject } from "../persistence/json.js"
import type { ApprovalReviewVerdict } from "./approval-review.js"

interface ReviewPlan {
  readonly name: string
  readonly description: string
  readonly args: JsonObject
  readonly preview: string
}

type SharedReview = (
  review: (plan: ReviewPlan) => Promise<ApprovalReviewVerdict>
) => Promise<ApprovalReviewVerdict>

export interface ReviewPlans {
  readonly open: (plan: ReviewPlan) => {
    readonly cover: (toolCallId: string) => void
    readonly close: () => void
  }
  readonly reviewOf: (toolCallId: string) => SharedReview | undefined
}

export const makeReviewPlans = (): ReviewPlans => {
  const marks = new Map<string, SharedReview>()
  return {
    open: (plan) => {
      let verdict: Promise<ApprovalReviewVerdict> | undefined
      const shared: SharedReview = (review) => (verdict ??= review(plan))
      const covered: Array<string> = []
      return {
        cover: (toolCallId) => {
          covered.push(toolCallId)
          marks.set(toolCallId, shared)
        },
        close: () => {
          for (const toolCallId of covered) marks.delete(toolCallId)
        }
      }
    },
    reviewOf: (toolCallId) => marks.get(toolCallId)
  }
}
