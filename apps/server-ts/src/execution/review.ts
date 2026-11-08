import type { OutwardCategory } from "./impact.js"

type ReviewRisk = "low" | "medium" | "high" | "critical"
type ReviewAuthorization = "high" | "medium" | "low" | "unknown"

export type ReviewAuthorizationSource = "owner" | "brief"

export type ReviewPolicyCategory = "none" | "external_send" | "delete_data" | "spend"

export interface ReviewAssessment {
  readonly verdict: "allow" | "ask"
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
  | { readonly decision: "allow"; readonly decided_by: "outcome" }
  | { readonly decision: "ask"; readonly decided_by: "outcome" | "policy" }

export const withKnownCategory = (
  assessment: ReviewAssessment,
  category: OutwardCategory
): ReviewAssessment =>
  category === "unknown" || assessment.policy_category !== "none"
    ? assessment
    : { ...assessment, policy_category: category }

const effectiveAuthorization = (assessment: ReviewAssessment): ReviewAuthorization =>
  assessment.authorization_source === "brief" && assessment.authorization === "high"
    ? "medium"
    : assessment.authorization

const atLeastMedium = (authorization: ReviewAuthorization): boolean =>
  authorization === "high" || authorization === "medium"

export const judgeAssessment = (assessment: ReviewAssessment): ReviewJudgement => {
  if (assessment.malicious_prompt_injection || assessment.risk === "critical")
    return { decision: "ask", decided_by: "outcome" }
  const authorization = effectiveAuthorization(assessment)
  const ownerAuthorized =
    assessment.authorization_source === "owner" && atLeastMedium(authorization)
  if (assessment.policy_category !== "none" && !ownerAuthorized)
    return { decision: "ask", decided_by: "policy" }
  if (assessment.risk === "high" && !(ownerAuthorized && assessment.narrowly_scoped))
    return { decision: "ask", decided_by: "outcome" }
  return { decision: "allow", decided_by: "outcome" }
}

export type ReviewEnding = "denied" | "passed"

export const reviewEnding = (
  decision: string,
  decidedBy: string,
  answer: string | null | undefined
): ReviewEnding | undefined => {
  if (decision === "allow") return "passed"
  if (decidedBy !== "outcome" && decidedBy !== "policy") return undefined
  if (answer === "rejected") return "denied"
  return answer === "approved" || answer === "ran" ? "passed" : undefined
}

export const REVIEW_BREAKER = { consecutive: 3, recent: 10, window: 50 } as const

export const reviewBreakerTripped = (newestFirst: ReadonlyArray<ReviewEnding>): boolean => {
  const window = newestFirst.slice(0, REVIEW_BREAKER.window)
  const firstPass = window.indexOf("passed")
  const consecutive = firstPass === -1 ? window.length : firstPass
  const recent = window.filter((ending) => ending === "denied").length
  return consecutive >= REVIEW_BREAKER.consecutive || recent >= REVIEW_BREAKER.recent
}
