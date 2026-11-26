import { retryableStatus } from "@arden-hq/std/retry"

import type { ProviderErrorCode } from "../../errors.js"

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

export class SemanticResponseError extends ProviderError {
  constructor(message: string, code: ProviderErrorCode = "provider_error") {
    super(message, { code, retryable: false })
  }
}

export class RetryableProviderError extends ProviderError {
  constructor(message: string, code: ProviderErrorCode = "provider_unavailable") {
    super(message, { code, retryable: true })
  }
}

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
