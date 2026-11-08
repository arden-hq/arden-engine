import { retryableStatus } from "@arden-hq/std/retry"

import type { ProviderErrorCode } from "../../errors.js"

/**
 * A classified provider failure. `code` is what the loop's `providerErrorCode`
 * reads along the cause chain and hands to the host; `retryable` is what the
 * kit's transport retry reads. Both are set where the failure is thrown, never
 * re-derived from the message.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly retryable: boolean

  constructor(
    message: string,
    options: { readonly code: ProviderErrorCode; readonly retryable: boolean }
  ) {
    super(message)
    this.code = options.code
    this.retryable = options.retryable
  }
}

/** A response the model itself rejected — never retried. */
export class SemanticResponseError extends ProviderError {
  constructor(message: string, code: ProviderErrorCode = "provider_error") {
    super(message, { code, retryable: false })
  }
}

/** A transport-level failure eligible for the bounded transport retry. */
export class RetryableProviderError extends ProviderError {
  constructor(message: string, code: ProviderErrorCode = "provider_unavailable") {
    super(message, { code, retryable: true })
  }
}

/**
 * A non-OK HTTP status with its retry headers. 408 (a server-side timeout),
 * 429 and 5xx retry; every other status is terminal. The provider names the
 * `code` and the message.
 */
export class HttpStatusError extends ProviderError {
  readonly status: number
  readonly retryAfter: string | null
  readonly retryAfterMs: string | null

  constructor(
    message: string,
    options: {
      readonly status: number
      readonly retryAfter: string | null
      readonly retryAfterMs: string | null
      readonly code: ProviderErrorCode
    }
  ) {
    super(message, {
      code: options.code,
      retryable: retryableStatus(options.status)
    })
    this.status = options.status
    this.retryAfter = options.retryAfter
    this.retryAfterMs = options.retryAfterMs
  }
}
