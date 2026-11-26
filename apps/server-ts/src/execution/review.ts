const REVIEW_RISK = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical"
} as const
type ReviewRisk = (typeof REVIEW_RISK)[keyof typeof REVIEW_RISK]

const REVIEW_AUTHORIZATION = {
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "unknown"
} as const
type ReviewAuthorization = (typeof REVIEW_AUTHORIZATION)[keyof typeof REVIEW_AUTHORIZATION]

export const REVIEW_AUTHORIZATION_SOURCE = { owner: "owner", brief: "brief" } as const
export type ReviewAuthorizationSource =
  (typeof REVIEW_AUTHORIZATION_SOURCE)[keyof typeof REVIEW_AUTHORIZATION_SOURCE]

const REVIEW_POLICY_CATEGORY = {
  none: "none",
  externalSend: "external_send",
  deleteData: "delete_data",
  spend: "spend"
} as const
type ReviewPolicyCategory = (typeof REVIEW_POLICY_CATEGORY)[keyof typeof REVIEW_POLICY_CATEGORY]

export const OUTWARD_CATEGORY = {
  externalSend: REVIEW_POLICY_CATEGORY.externalSend,
  deleteData: REVIEW_POLICY_CATEGORY.deleteData,
  spend: REVIEW_POLICY_CATEGORY.spend,
  unknown: "unknown"
} as const
export type OutwardCategory = (typeof OUTWARD_CATEGORY)[keyof typeof OUTWARD_CATEGORY]

export const REVIEW_DECISION = { allow: "allow", ask: "ask" } as const
type ReviewDecision = (typeof REVIEW_DECISION)[keyof typeof REVIEW_DECISION]

const REVIEW_DECIDED_BY = { outcome: "outcome", policy: "policy" } as const
type ReviewDecidedBy = (typeof REVIEW_DECIDED_BY)[keyof typeof REVIEW_DECIDED_BY]

export interface ReviewAssessment {
  readonly verdict: ReviewDecision
  readonly risk: ReviewRisk
  readonly authorization: ReviewAuthorization
  readonly authorization_source: ReviewAuthorizationSource
  readonly policy_category: ReviewPolicyCategory
  readonly narrowly_scoped: boolean
  readonly malicious_prompt_injection: boolean
  readonly rationale: string
  readonly rule?: string
  readonly abbreviated: boolean
}

export type ReviewJudgement =
  | {
      readonly decision: typeof REVIEW_DECISION.allow
      readonly decided_by: typeof REVIEW_DECIDED_BY.outcome
    }
  | { readonly decision: typeof REVIEW_DECISION.ask; readonly decided_by: ReviewDecidedBy }

const isReviewDecidedBy = (value: string): value is ReviewDecidedBy =>
  Object.values(REVIEW_DECIDED_BY).some((decider) => decider === value)

export const withKnownCategory = (
  assessment: ReviewAssessment,
  category: OutwardCategory
): ReviewAssessment =>
  category === OUTWARD_CATEGORY.unknown ||
  assessment.policy_category !== REVIEW_POLICY_CATEGORY.none
    ? assessment
    : { ...assessment, policy_category: category }

const effectiveAuthorization = (assessment: ReviewAssessment): ReviewAuthorization =>
  assessment.authorization_source === REVIEW_AUTHORIZATION_SOURCE.brief &&
  assessment.authorization === REVIEW_AUTHORIZATION.high
    ? REVIEW_AUTHORIZATION.medium
    : assessment.authorization

const atLeastMedium = (authorization: ReviewAuthorization): boolean =>
  authorization === REVIEW_AUTHORIZATION.high || authorization === REVIEW_AUTHORIZATION.medium

const ASK_BY_OUTCOME: ReviewJudgement = {
  decision: REVIEW_DECISION.ask,
  decided_by: REVIEW_DECIDED_BY.outcome
}

export const judgeAssessment = (assessment: ReviewAssessment): ReviewJudgement => {
  if (assessment.malicious_prompt_injection || assessment.risk === REVIEW_RISK.critical)
    return ASK_BY_OUTCOME
  const authorization = effectiveAuthorization(assessment)
  const ownerAuthorized =
    assessment.authorization_source === REVIEW_AUTHORIZATION_SOURCE.owner &&
    atLeastMedium(authorization)
  if (assessment.policy_category !== REVIEW_POLICY_CATEGORY.none && !ownerAuthorized)
    return { decision: REVIEW_DECISION.ask, decided_by: REVIEW_DECIDED_BY.policy }
  if (assessment.risk === REVIEW_RISK.high && !(ownerAuthorized && assessment.narrowly_scoped))
    return ASK_BY_OUTCOME
  return { decision: REVIEW_DECISION.allow, decided_by: REVIEW_DECIDED_BY.outcome }
}

const REVIEW_ENDING = { denied: "denied", passed: "passed" } as const
export type ReviewEnding = (typeof REVIEW_ENDING)[keyof typeof REVIEW_ENDING]

const REVIEW_CARD_ANSWER = {
  approved: "approved",
  rejected: "rejected",
  ran: "ran"
} as const
type ReviewCardAnswer = (typeof REVIEW_CARD_ANSWER)[keyof typeof REVIEW_CARD_ANSWER]

const isReviewCardAnswer = (value: string): value is ReviewCardAnswer =>
  Object.values(REVIEW_CARD_ANSWER).some((answer) => answer === value)

const ENDING_OF_ANSWER: Record<ReviewCardAnswer, ReviewEnding> = {
  approved: REVIEW_ENDING.passed,
  rejected: REVIEW_ENDING.denied,
  ran: REVIEW_ENDING.passed
}

export const reviewEnding = (
  decision: string,
  decidedBy: string,
  answer: string | null | undefined
): ReviewEnding | undefined => {
  if (decision === REVIEW_DECISION.allow) return REVIEW_ENDING.passed
  if (!isReviewDecidedBy(decidedBy)) return undefined
  return answer !== null && answer !== undefined && isReviewCardAnswer(answer)
    ? ENDING_OF_ANSWER[answer]
    : undefined
}

export const REVIEW_BREAKER = { consecutive: 3, recent: 10, window: 50 } as const

export const reviewBreakerTripped = (newestFirst: ReadonlyArray<ReviewEnding>): boolean => {
  const window = newestFirst.slice(0, REVIEW_BREAKER.window)
  const firstPass = window.indexOf(REVIEW_ENDING.passed)
  const consecutive = firstPass === -1 ? window.length : firstPass
  const recent = window.filter((ending) => ending === REVIEW_ENDING.denied).length
  return consecutive >= REVIEW_BREAKER.consecutive || recent >= REVIEW_BREAKER.recent
}
