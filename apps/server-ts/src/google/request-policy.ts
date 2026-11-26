import {
  backoffDelayMs,
  parseRetryAfter,
  retryAfterHints,
  retryableStatus
} from "@arden-hq/std/retry"
import { Option, Schema } from "effect"

import { GOOGLE_API_ERROR_REASON, type GoogleConnectionDiagnostic } from "./errors.js"

const RETRY_SAFE_METHOD = { GET: "GET", HEAD: "HEAD" } as const

type RetrySafeMethod = (typeof RETRY_SAFE_METHOD)[keyof typeof RETRY_SAFE_METHOD]

const retrySafeMethods: ReadonlySet<string> = new Set<RetrySafeMethod>(
  Object.values(RETRY_SAFE_METHOD)
)

export const isRetrySafeMethod = (method: string): method is RetrySafeMethod =>
  retrySafeMethods.has(method)

export const GOOGLE_API_MAX_ATTEMPTS = 3

export const GOOGLE_RETRY_MAX_DELAY_MS = 5_000
const BACKOFF = { initialMs: 250, maxMs: GOOGLE_RETRY_MAX_DELAY_MS, jitter: 0.25 }
const RATE_LIMIT_REASONS = new Set([
  "dailyLimitExceeded",
  "quotaExceeded",
  "rateLimitExceeded",
  "sharingRateLimitExceeded",
  "userRateLimitExceeded"
])
const RETRYABLE_RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "sharingRateLimitExceeded",
  "userRateLimitExceeded"
])
const ApiErrorResponseSchema = Schema.Struct({
  error: Schema.Struct({
    errors: Schema.optionalKey(Schema.Array(Schema.Struct({ reason: Schema.String })))
  })
})
const decodeApiErrorResponse = Schema.decodeUnknownOption(ApiErrorResponseSchema)

type HttpDiagnostic = Extract<GoogleConnectionDiagnostic, { readonly kind: "http" }>

export const googleApiDiagnostic = (
  response: Response,
  value: unknown,
  now: number,
  safeToRetry: boolean
): HttpDiagnostic => {
  const reasons = apiErrorReasons(value)
  const retryableRateLimit =
    response.status === 403 && reasons.some((reason) => RETRYABLE_RATE_LIMIT_REASONS.has(reason))
  return {
    kind: "http",
    status: response.status,
    reason: apiErrorReason(response.status, reasons),
    retryAfterMs: parseRetryAfter(retryAfterHints(response.headers), now),
    retryable: safeToRetry && (retryableStatus(response.status) || retryableRateLimit)
  }
}

export const googleApiErrorMessage = (diagnostic: HttpDiagnostic): string => {
  const retry =
    diagnostic.retryAfterMs === undefined ? "" : ` Retry after ${diagnostic.retryAfterMs} ms.`
  switch (diagnostic.reason) {
    case GOOGLE_API_ERROR_REASON.auth:
      return `Google authorization does not permit this operation (HTTP ${diagnostic.status}).`
    case GOOGLE_API_ERROR_REASON.rateLimit:
      return `Google API rate limit exceeded (HTTP ${diagnostic.status}).${retry}`
    case GOOGLE_API_ERROR_REASON.provider:
      return `Google API is temporarily unavailable (HTTP ${diagnostic.status}).${retry}`
    case GOOGLE_API_ERROR_REASON.request:
      return `Google API rejected the request (HTTP ${diagnostic.status}).`
  }
}

export const googleRetryDelayMs = (
  attempt: number,
  retryAfterMs: number | undefined,
  random: number
): number => retryAfterMs ?? backoffDelayMs(BACKOFF, attempt, random)

const apiErrorReasons = (value: unknown): ReadonlyArray<string> =>
  Option.getOrUndefined(decodeApiErrorResponse(value))?.error.errors?.map(
    (error) => error.reason
  ) ?? []

const apiErrorReason = (
  status: number,
  reasons: ReadonlyArray<string>
): HttpDiagnostic["reason"] => {
  if (status === 429) return "rate_limit"
  if (status === 401) return "auth"
  if (status === 403) {
    return reasons.some((reason) => RATE_LIMIT_REASONS.has(reason)) ? "rate_limit" : "auth"
  }
  return status >= 500 ? "provider" : "request"
}
