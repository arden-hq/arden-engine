import type { ProviderErrorCode } from "../../errors.js"
import { classifyRejection, httpRejection, ProviderError } from "../kit/index.js"

export class OpenAiResponsesProviderError extends ProviderError {
  override readonly name = "OpenAiResponsesProviderError"

  constructor(message: string, code: ProviderErrorCode = "provider_error") {
    super(message, { code, retryable: false })
  }
}

export const RESPONSE_ERROR_CODE = {
  nativeTurnContextMismatch: "native_turn_context_mismatch",
  previousResponseNotFound: "previous_response_not_found"
} as const
type ResponseErrorCode = (typeof RESPONSE_ERROR_CODE)[keyof typeof RESPONSE_ERROR_CODE]
const RESPONSE_ERROR_CODES: ReadonlySet<string | null> = new Set(Object.values(RESPONSE_ERROR_CODE))
export const isResponseErrorCode = (value: string | null): value is ResponseErrorCode =>
  RESPONSE_ERROR_CODES.has(value)

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

export const statusFailureCode = (status: number, detail: string | null): ProviderErrorCode =>
  classifyRejection(httpRejection(status, detail ?? undefined), TERMINAL_RESPONSE_CODES)
