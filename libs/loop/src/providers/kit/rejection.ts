import { isRecord } from "@arden-hq/std/json"
import { retryableStatus } from "@arden-hq/std/retry"
import { clipLine } from "@arden-hq/std/text"

import { PROVIDER_ERROR_CODE, type ProviderErrorCode } from "../../errors.js"
import { HttpStatusError } from "./errors.js"
import { parseJsonText } from "@arden-hq/std/json-text"

export const MAX_STATUS_DETAIL_CHARS = 600

export interface Rejection {
  readonly status: number | undefined
  readonly code: string | undefined
  readonly type: string | undefined
  readonly errorType: string | undefined
  readonly message: string | undefined
  readonly upstream: UpstreamRejection | undefined
}

/**
 * The upstream's own error behind a router's generic "Provider returned
 * error". OpenRouter relays the upstream body verbatim as the string
 * `error.metadata.raw` (https://openrouter.ai/docs/api-reference/errors), and
 * may name the upstream's code beside it: `provider_code` in the docs,
 * `provider_error_code` in every live body (2026-11-16). `raw` is parsed as
 * that upstream's own error body: Anthropic `{type:"error",error:{type,
 * message}}`, OpenAI `{error:{message,type,code}}`, Bedrock `{message}`. Raw
 * text that is not JSON (a throttle notice) gives no fields.
 */
export interface UpstreamRejection {
  readonly code: string | undefined
  readonly type: string | undefined
  readonly message: string | undefined
}

/**
 * A context overflow in prose, in the wording each server we talk to uses,
 * kept to wordings that name the size of the context or the prompt. Taken from
 * prime `utils_inner/overflow.rs` (and openclaw `utils/overflow.ts`, the same
 * table), limited to OpenAI, OpenRouter, llama.cpp, LM Studio, Ollama and
 * gateways. Left out on purpose: their generic "too many tokens" and "token
 * limit exceeded", which throttles and quotas use ("Tokens per minute limit
 * exceeded - too many tokens processed."; OpenRouter's `token_limit_exceeded`
 * is "a token budget enforced by OpenRouter, such as a credit-based cap",
 * https://openrouter.ai/docs/api-reference/errors), and the 413 body wordings,
 * which the 413 status already decides.
 */
const LLAMA_CPP_OVERFLOW_PROSE = /exceeds the available context size/i

const ANTHROPIC_OVERFLOW_PROSE_RELAYED_BY_OPENROUTER = /prompt is too long/i

const CONTEXT_OVERFLOW_PROSE: ReadonlyArray<RegExp> = [
  /context (?:length|window)/i,
  /context[_ ]length[_ ]exceeded/i,
  LLAMA_CPP_OVERFLOW_PROSE,
  ANTHROPIC_OVERFLOW_PROSE_RELAYED_BY_OPENROUTER
]

const THROTTLE_OR_QUOTA_PROSE: ReadonlyArray<RegExp> = [
  /rate limit/i,
  /too many requests/i,
  /quota/i,
  /per (?:minute|min|hour|day)\b/i
]

const OVERFLOW_STATUSES: ReadonlySet<number> = new Set([400, 413])

const MODEL_UNAVAILABLE_PROSE =
  /\bmodel\b.{0,80}?\b(?:is not supported|does not exist|is not available|not found)\b|\bis not a valid model id\b/i

const UPSTREAM_ERROR_NAME = {
  contextLengthExceeded: "context_length_exceeded",
  exceedContextSizeError: "exceed_context_size_error",
  invalidRequestError: "invalid_request_error"
} as const
type UpstreamErrorName = (typeof UPSTREAM_ERROR_NAME)[keyof typeof UPSTREAM_ERROR_NAME]

const names = (value: string | undefined, name: UpstreamErrorName): boolean => value === name

export const isContextOverflow = (rejection: Rejection): boolean => {
  if (names(rejection.code, UPSTREAM_ERROR_NAME.contextLengthExceeded)) return true
  if (names(rejection.type, UPSTREAM_ERROR_NAME.exceedContextSizeError)) return true
  if (names(rejection.errorType, UPSTREAM_ERROR_NAME.contextLengthExceeded)) return true
  if (names(rejection.upstream?.code, UPSTREAM_ERROR_NAME.contextLengthExceeded)) return true
  if (rejection.status === 413) return true
  if (rejection.status === undefined || !OVERFLOW_STATUSES.has(rejection.status)) return false
  return [rejection.message, rejection.upstream?.message].some(
    (message) =>
      message !== undefined &&
      !THROTTLE_OR_QUOTA_PROSE.some((pattern) => pattern.test(message)) &&
      CONTEXT_OVERFLOW_PROSE.some((pattern) => pattern.test(message))
  )
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

export const rejectionFields = (body: unknown): Omit<Rejection, "status"> => {
  const record = isRecord(body) ? body : undefined
  const error = isRecord(record?.error) ? record.error : undefined
  const metadata = isRecord(error?.metadata) ? error.metadata : undefined
  return {
    code: stringOf(error?.code),
    type: stringOf(error?.type),
    errorType: stringOf(metadata?.error_type),
    message: stringOf(error?.message) ?? stringOf(record?.error) ?? stringOf(record?.detail),
    upstream: metadata === undefined ? undefined : upstreamRejection(metadata)
  }
}

const upstreamRejection = (
  metadata: Readonly<Record<string, unknown>>
): UpstreamRejection | undefined => {
  const raw = parseJson(stringOf(metadata.raw))
  const body = isRecord(raw) ? raw : undefined
  const error = isRecord(body?.error) ? body.error : undefined
  const upstream: UpstreamRejection = {
    code:
      stringOf(metadata.provider_error_code) ??
      stringOf(metadata.provider_code) ??
      stringOf(error?.code),
    type: stringOf(error?.type),
    message: stringOf(error?.message) ?? stringOf(body?.message)
  }
  return Object.values(upstream).every((value) => value === undefined) ? undefined : upstream
}

export const httpRejection = (status: number, detail: string | undefined): Rejection => ({
  status,
  ...rejectionFields(parseJson(detail))
})

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return parseJsonText(text)
  } catch {
    return undefined
  }
}

export const classifyRejection = (
  rejection: Rejection,
  declared: Readonly<Record<string, ProviderErrorCode>>
): ProviderErrorCode => {
  const known = rejection.code === undefined ? undefined : declared[rejection.code]
  if (known !== undefined) return known
  if (isContextOverflow(rejection)) return PROVIDER_ERROR_CODE.contextLengthExceeded
  const status = rejection.status
  if (
    (status === 400 || status === 403 || status === 404) &&
    rejection.message !== undefined &&
    MODEL_UNAVAILABLE_PROSE.test(rejection.message)
  )
    return PROVIDER_ERROR_CODE.modelUnavailable
  if (
    status === 400 &&
    (names(rejection.type, UPSTREAM_ERROR_NAME.invalidRequestError) ||
      names(rejection.upstream?.type, UPSTREAM_ERROR_NAME.invalidRequestError))
  )
    return PROVIDER_ERROR_CODE.requestInvalid
  if (status === 401 || status === 403) return PROVIDER_ERROR_CODE.providerAuth
  if (status === 429) return PROVIDER_ERROR_CODE.rateLimited
  if (status !== undefined && retryableStatus(status))
    return PROVIDER_ERROR_CODE.providerUnavailable
  return PROVIDER_ERROR_CODE.providerError
}

export class ProviderStatusError extends HttpStatusError {
  readonly detail: string | undefined

  constructor(options: {
    readonly label: string
    readonly status: number
    readonly retryAfter: string | null
    readonly retryAfterMs: string | null
    readonly detail: string | undefined
    readonly classify: (status: number, detail: string | undefined) => ProviderErrorCode
  }) {
    const clipped =
      options.detail === undefined
        ? undefined
        : clipLine(options.detail, MAX_STATUS_DETAIL_CHARS) || undefined
    const prefix = `${options.label} request failed with status ${options.status}`
    super(clipped === undefined ? prefix : `${prefix}: ${clipped}`, {
      status: options.status,
      retryAfter: options.retryAfter,
      retryAfterMs: options.retryAfterMs,
      code: options.classify(options.status, options.detail)
    })
    this.detail = clipped
  }
}
