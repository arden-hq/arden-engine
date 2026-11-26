import { errorMessage, redactedFailureText } from "@arden-hq/std/errors"
import {
  FinishReason,
  providerErrorCode,
  type CompletionResponse,
  type ProviderErrorCode
} from "@arden-hq/loop"
import { Schema } from "effect"
import { STRUCTURED_OUTPUT_DIALECTS } from "../models/structured-output.js"
import {
  REVIEW_AUTHORIZATION_SOURCE,
  REVIEW_DECISION,
  type ReviewAssessment,
  type ReviewAuthorizationSource
} from "../execution/review.js"

export const RULE_WORDS_MAX = 120

export const VerdictSchema = Schema.Struct({
  authorization: Schema.Literals(["high", "medium", "low", "unknown"]),
  authorization_source: Schema.Literals(["owner", "brief"]),
  risk: Schema.Literals(["low", "medium", "high", "critical"]),
  policy_category: Schema.Literals(["none", "external_send", "delete_data", "spend"]),
  narrowly_scoped: Schema.Boolean,
  malicious_prompt_injection: Schema.Boolean,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  rule: Schema.optional(Schema.String),
  verdict: Schema.Literals(["allow", "ask"])
})

const GUARDIAN_OUTCOME = { allow: "allow", deny: "deny" } as const

const GuardianSchema = Schema.Struct({
  risk_level: VerdictSchema.fields.risk,
  user_authorization: VerdictSchema.fields.authorization,
  authorization_source: Schema.optional(VerdictSchema.fields.authorization_source),
  policy_category: VerdictSchema.fields.policy_category,
  narrowly_scoped: Schema.optional(Schema.Boolean),
  outcome: Schema.Literals(Object.values(GUARDIAN_OUTCOME)),
  rationale: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  rule: Schema.optional(Schema.String),
  malicious_prompt_injection: Schema.optional(Schema.Boolean)
})

export const guardianSchema = STRUCTURED_OUTPUT_DIALECTS.openai(
  Schema.Struct({
    ...GuardianSchema.fields,
    authorization_source: VerdictSchema.fields.authorization_source,
    narrowly_scoped: Schema.Boolean,
    rule: Schema.String,
    malicious_prompt_injection: Schema.Boolean
  })
).jsonSchema

const AUTHORITY_SHOWN = { owner: "owner", mixed: "mixed", untrusted: "untrusted" } as const

export type AuthorityShown = (typeof AUTHORITY_SHOWN)[keyof typeof AUTHORITY_SHOWN]

export const sourceOf = (
  said: ReviewAuthorizationSource | undefined,
  shown: AuthorityShown
): ReviewAuthorizationSource => {
  switch (shown) {
    case AUTHORITY_SHOWN.owner:
      return REVIEW_AUTHORIZATION_SOURCE.owner
    case AUTHORITY_SHOWN.untrusted:
      return REVIEW_AUTHORIZATION_SOURCE.brief
    case AUTHORITY_SHOWN.mixed:
      return said ?? REVIEW_AUTHORIZATION_SOURCE.brief
  }
}

export const ruleOf = (rule: string | undefined): { readonly rule?: string } => {
  const words = rule?.replace(/\s+/gu, " ").trim()
  return words === undefined || words === "" || words.length > RULE_WORDS_MAX ? {} : { rule: words }
}

const decodeGuardian = Schema.decodeUnknownSync(Schema.fromJsonString(GuardianSchema))

const parseGuardianAssessment = (text: string | null, shown: AuthorityShown): ReviewAssessment => {
  const full = decodeGuardian(text ?? "", { onExcessProperty: "error" })
  return {
    verdict: full.outcome === GUARDIAN_OUTCOME.allow ? REVIEW_DECISION.allow : REVIEW_DECISION.ask,
    risk: full.risk_level,
    authorization: full.user_authorization,
    authorization_source: sourceOf(full.authorization_source, shown),
    policy_category: full.policy_category,
    narrowly_scoped: full.narrowly_scoped ?? false,
    malicious_prompt_injection: full.malicious_prompt_injection ?? false,
    rationale: full.rationale,
    ...ruleOf(full.rule),
    abbreviated: false
  }
}

const GUARD_UNAVAILABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "provider_unavailable",
  "rate_limited",
  "provider_auth",
  "model_unavailable"
])
export const guardUnavailable = (cause: unknown): boolean => {
  const code = providerErrorCode(cause)
  return code !== undefined && GUARD_UNAVAILABLE.has(code)
}

export class GuardUnanswered extends Error {
  constructor(cause: unknown) {
    super("The guard model gave no answer", { cause })
  }
}

export const causeChain = (cause: unknown): string => {
  const parts: string[] = []
  for (let at: unknown = cause, depth = 0; at !== undefined && depth < 6; depth += 1) {
    parts.push(at instanceof Error ? `${at.name}: ${errorMessage(at)}` : errorMessage(at))
    at = at instanceof Error ? at.cause : undefined
  }
  return redactedFailureText(parts.join(" <- "))
}

export const guardianAssessment = async (
  complete: () => Promise<CompletionResponse>,
  shown: AuthorityShown
): Promise<ReviewAssessment> => {
  const response = await complete()
  if (
    response.continuation ||
    response.finish_reason !== FinishReason.STOP ||
    response.message.tool_calls?.length ||
    response.message.provider_tool_calls?.length
  )
    throw new Error("Approval review did not return a final assessment")
  return parseGuardianAssessment(response.message.content, shown)
}
