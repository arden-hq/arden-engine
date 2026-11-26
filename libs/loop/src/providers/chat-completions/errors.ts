import { isRecord } from "@arden-hq/std/json"
import { retryableStatus } from "@arden-hq/std/retry"
import { clipLine } from "@arden-hq/std/text"

import { PROVIDER_ERROR_CODE, type ProviderErrorCode } from "../../errors.js"
import {
  classifyRejection,
  httpRejection,
  MAX_STATUS_DETAIL_CHARS,
  ProviderError,
  RetryableProviderError,
  rejectionFields,
  SemanticResponseError
} from "../kit/index.js"

export class ChatCompletionsProviderError extends ProviderError {
  override readonly name = "ChatCompletionsProviderError"

  constructor(message: string, code: ProviderErrorCode = "provider_error") {
    super(message, { code, retryable: false })
  }
}

const DECLARED_CODES: Readonly<Record<string, ProviderErrorCode>> = {
  context_length_exceeded: "context_length_exceeded",
  insufficient_quota: "rate_limited",
  model_not_found: "model_unavailable"
}

export const statusFailureCode = (status: number, detail: string | undefined): ProviderErrorCode =>
  classifyRejection(httpRejection(status, detail), DECLARED_CODES)

export const errorFrameFailure = (label: string, chunk: unknown): ProviderError => {
  const error = isRecord(chunk) && isRecord(chunk.error) ? chunk.error : {}
  const status = typeof error.code === "number" ? error.code : undefined
  const fields = rejectionFields(chunk)
  const code = classifyRejection({ status, ...fields }, DECLARED_CODES)
  const named = fields.code ?? (status === undefined ? undefined : String(status))
  const head = named === undefined ? `${label} stream failed` : `${label} stream failed (${named})`
  const said = fields.message === undefined ? "" : clipLine(fields.message, MAX_STATUS_DETAIL_CHARS)
  const message = said.length === 0 ? head : `${head}: ${said}`
  const retryable =
    status === undefined ? code === PROVIDER_ERROR_CODE.providerError : retryableStatus(status)
  return retryable
    ? new RetryableProviderError(message, code)
    : new SemanticResponseError(message, code)
}
