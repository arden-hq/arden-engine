export const APPROVAL_REVIEW_ASK = {
  judged: "judged",
  timedOut: "timed_out",
  failed: "failed",
  stopped: "stopped"
} as const

export const APPROVAL_REVIEW_VERDICT = { allow: "allow", ask: "ask" } as const

export type ApprovalReviewAsk =
  | {
      readonly kind: typeof APPROVAL_REVIEW_ASK.judged
      readonly reason: string
      readonly rule?: string
    }
  | { readonly kind: typeof APPROVAL_REVIEW_ASK.timedOut }
  | { readonly kind: typeof APPROVAL_REVIEW_ASK.failed }
  | { readonly kind: typeof APPROVAL_REVIEW_ASK.stopped }

export type ApprovalReviewVerdict =
  | { readonly verdict: typeof APPROVAL_REVIEW_VERDICT.allow; readonly reason: string }
  | { readonly verdict: typeof APPROVAL_REVIEW_VERDICT.ask; readonly why: ApprovalReviewAsk }
