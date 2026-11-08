import { retryableStatus } from "@arden-hq/std/retry"
import { clipLine } from "@arden-hq/std/text"

import type { ProviderErrorCode } from "../../errors.js"
import { HttpStatusError, ProviderError } from "../kit/index.js"
import { asRecord, stringValue } from "./items.js"

/** The public failure type of this provider. Deliberately NOT a LoopError. */
export class OpenAiResponsesProviderError extends ProviderError {
  override readonly name = "OpenAiResponsesProviderError"

  constructor(message: string, code: ProviderErrorCode = "provider_error") {
    super(message, { code, retryable: false })
  }
}

/** How much of a rejection body is worth carrying into the error message. */
export const MAX_STATUS_DETAIL_CHARS = 600

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

/**
 * A context overflow that a rejection reports only in prose. OpenAI omits the
 * `context_length_exceeded` code on some rejections and says it in the message
 * instead; the host taxonomy still has to see one class, not two.
 */
const CONTEXT_OVERFLOW_PROSE = /context (?:length|window)/i

/**
 * A refusal of the model itself, in prose. The Codex backend answers a model
 * the ChatGPT sign-in may not use with a bare `{"detail": "The '<model>'
 * model is not supported when using Codex with a ChatGPT account."}`, and the
 * Platform API says "The model `<model>` does not exist or you do not have
 * access to it." Only the provider's own sentence is read, never the request
 * echo around it.
 */
const MODEL_UNAVAILABLE_PROSE =
  /\bmodel\b.{0,80}?\b(?:is not supported|does not exist|is not available|not found)\b/i

const rejection = (
  detail: string | null
): {
  readonly code: string | undefined
  readonly type: string | undefined
  readonly message: string | undefined
} => {
  const none = { code: undefined, type: undefined, message: undefined }
  if (detail === null) return none
  let decoded: unknown
  try {
    decoded = JSON.parse(detail)
  } catch {
    return none
  }
  const body = asRecord(decoded)
  const error = asRecord(body?.error)
  return {
    code: stringValue(error?.code) ?? undefined,
    type: stringValue(error?.type) ?? undefined,
    message: stringValue(error?.message) ?? stringValue(body?.detail) ?? undefined
  }
}

/** The failure code of a non-OK HTTP status, from the body when one was read. */
export const statusFailureCode = (status: number, detail: string | null): ProviderErrorCode => {
  const refused = rejection(detail)
  const declared = TERMINAL_RESPONSE_CODES[refused.code ?? ""]
  if (declared !== undefined) return declared
  if (detail !== null && CONTEXT_OVERFLOW_PROSE.test(detail)) return "context_length_exceeded"
  if (
    (status === 400 || status === 403 || status === 404) &&
    refused.message !== undefined &&
    MODEL_UNAVAILABLE_PROSE.test(refused.message)
  )
    return "model_unavailable"
  if (status === 400 && refused.type === "invalid_request_error") return "request_invalid"
  if (status === 401 || status === 403) return "provider_auth"
  if (status === 429) return "rate_limited"
  if (retryableStatus(status)) return "provider_unavailable"
  return "provider_error"
}

/**
 * A non-OK HTTP status, carrying the retry-after headers and — when the caller
 * could read one — what the provider actually said. A bare status is nearly
 * useless for a 400: the reason a request was rejected lives only in its body.
 */
export class StatusError extends HttpStatusError {
  readonly detail: string | null

  constructor(
    status: number,
    retryAfter: string | null,
    retryAfterMs: string | null = null,
    detail: string | null = null
  ) {
    const trimmed = detail === null ? null : clipLine(detail, MAX_STATUS_DETAIL_CHARS) || null
    super(
      trimmed === null
        ? `OpenAI request failed with status ${status}`
        : `OpenAI request failed with status ${status}: ${trimmed}`,
      { status, retryAfter, retryAfterMs, code: statusFailureCode(status, trimmed) }
    )
    this.detail = trimmed
  }
}
