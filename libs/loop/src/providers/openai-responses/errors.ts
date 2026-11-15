import type { ProviderErrorCode } from "../../errors.js"
import { classifyRejection, httpRejection, ProviderError } from "../kit/index.js"

/** The public failure type of this provider. Deliberately NOT a LoopError. */
export class OpenAiResponsesProviderError extends ProviderError {
  override readonly name = "OpenAiResponsesProviderError"

  constructor(message: string, code: ProviderErrorCode = "provider_error") {
    super(message, { code, retryable: false })
  }
}

/**
 * The response failures OpenAI names itself, mapped onto the host taxonomy.
 * Membership is also what makes a `response.failed` terminal: anything not
 * listed here is a missing, new, overloaded, or server-side code that spends
 * the retry budget instead.
 */
export const TERMINAL_RESPONSE_CODES: Readonly<Record<string, ProviderErrorCode>> = {
  bio_policy: "provider_error",
  content_filter: "provider_error",
  context_length_exceeded: "context_length_exceeded",
  cyber_policy: "provider_error",
  insufficient_quota: "rate_limited",
  invalid_prompt: "provider_error",
  invalid_request_error: "request_invalid",
  misalignment_policy_violation: "provider_error",
  model_not_found: "model_unavailable",
  usage_not_included: "provider_error"
}

/** The failure code of a non-OK HTTP status, from the body when one was read. */
export const statusFailureCode = (status: number, detail: string | null): ProviderErrorCode =>
  classifyRejection(httpRejection(status, detail ?? undefined), TERMINAL_RESPONSE_CODES)
