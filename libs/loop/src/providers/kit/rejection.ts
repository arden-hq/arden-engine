import { isRecord } from "@arden-hq/std/json"
import { retryableStatus } from "@arden-hq/std/retry"
import { clipLine } from "@arden-hq/std/text"

import type { ProviderErrorCode } from "../../errors.js"
import { HttpStatusError } from "./errors.js"

/** How much of a rejection body is worth carrying into the error message. */
export const MAX_STATUS_DETAIL_CHARS = 600

/**
 * What a provider said when it refused a request: the HTTP status (absent for
 * an error frame inside a stream that carries none), the `error.code` and
 * `error.type` of an OpenAI-style body, OpenRouter's typed class
 * (`error.metadata.error_type`), `message`, the server's own sentence, and
 * `upstream`, the error a router relayed from the model's own provider.
 * Nothing else of the body is kept: prose is read only from a message field,
 * never from the text around it.
 */
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
const CONTEXT_OVERFLOW_PROSE: ReadonlyArray<RegExp> = [
  // OpenAI says "maximum context length is N tokens" and, without the code on
  // some rejections, "exceeds the context window"; OpenRouter says "maximum
  // context length is N tokens" for every backend; LM Studio "greater than the
  // context length"; Ollama "prompt too long; exceeded max context length".
  /context (?:length|window)/i,
  /context[_ ]length[_ ]exceeded/i,
  /exceeds the available context size/i, // llama.cpp `llama-server`
  /prompt is too long/i // Anthropic, as OpenRouter relays it in its own message
]

/** A throttle or quota that happens to mention its window is never an overflow. */
const NOT_OVERFLOW_PROSE: ReadonlyArray<RegExp> = [
  /rate limit/i,
  /too many requests/i,
  /quota/i,
  /per (?:minute|min|hour|day)\b/i
]

/**
 * The statuses a server reports an overflow with, so the only ones whose prose
 * is read: OpenAI, OpenRouter (`context_length_exceeded`, "HTTP 400") and
 * llama.cpp answer 400, and a body over a byte limit is 413. Every other
 * status names its own class (401/403 auth, 408 and 5xx unavailable, 429
 * throttle) and is never an overflow by prose. 422 is not here: none of the
 * servers above uses it for an overflow (OpenRouter's 422 is `unprocessable`).
 */
const OVERFLOW_STATUSES: ReadonlySet<number> = new Set([400, 413])

/**
 * A refusal of the model itself, in prose. The Codex backend answers a model
 * the ChatGPT sign-in may not use with a bare `{"detail": "The '<model>'
 * model is not supported when using Codex with a ChatGPT account."}`, the
 * Platform API says "The model `<model>` does not exist or you do not have
 * access to it.", llama.cpp says "model '<model>' not found", and OpenRouter
 * "<model> is not a valid model ID" (live, 2026-11-16). Only the
 * provider's own sentence is read, never the request echo around it, and only
 * on the statuses a refused model comes with (400, 403, 404).
 */
const MODEL_UNAVAILABLE_PROSE =
  /\bmodel\b.{0,80}?\b(?:is not supported|does not exist|is not available|not found)\b|\bis not a valid model id\b/i

/**
 * Whether a rejection is a context overflow, decided by the strongest evidence
 * present, in order: a structured class the server sets (OpenAI's and
 * OpenRouter's `context_length_exceeded`, llama.cpp's
 * `exceed_context_size_error`) or the relayed upstream's code, HTTP 413, then
 * a message on a status an overflow comes with: the server's own, else the
 * upstream's. OpenRouter relays an Anthropic overflow only as the upstream's
 * message, "prompt is too long: 600023 tokens > 200000 maximum" (live,
 * 2026-11-16).
 */
export const isContextOverflow = (rejection: Rejection): boolean => {
  if (rejection.code === "context_length_exceeded") return true
  if (rejection.type === "exceed_context_size_error") return true
  if (rejection.errorType === "context_length_exceeded") return true
  if (rejection.upstream?.code === "context_length_exceeded") return true
  if (rejection.status === 413) return true
  if (rejection.status === undefined || !OVERFLOW_STATUSES.has(rejection.status)) return false
  return [rejection.message, rejection.upstream?.message].some(
    (message) =>
      message !== undefined &&
      !NOT_OVERFLOW_PROSE.some((pattern) => pattern.test(message)) &&
      CONTEXT_OVERFLOW_PROSE.some((pattern) => pattern.test(message))
  )
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/**
 * The fields of a decoded rejection body: `error.code`, `error.type`,
 * OpenRouter's `error.metadata.error_type`, the message — `error.message`,
 * Ollama's bare `error` string, or FastAPI-style `detail` — and the relayed
 * upstream error.
 */
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

/** A rejection read from an HTTP status and the body text, JSON or not. */
export const httpRejection = (status: number, detail: string | undefined): Rejection => ({
  status,
  ...rejectionFields(parseJson(detail))
})

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The one ladder from a rejection to the host taxonomy. `declared` maps the
 * error codes a provider documents as terminal; they win over everything else.
 */
export const classifyRejection = (
  rejection: Rejection,
  declared: Readonly<Record<string, ProviderErrorCode>>
): ProviderErrorCode => {
  const known = rejection.code === undefined ? undefined : declared[rejection.code]
  if (known !== undefined) return known
  if (isContextOverflow(rejection)) return "context_length_exceeded"
  const status = rejection.status
  if (
    (status === 400 || status === 403 || status === 404) &&
    rejection.message !== undefined &&
    MODEL_UNAVAILABLE_PROSE.test(rejection.message)
  )
    return "model_unavailable"
  if (
    status === 400 &&
    (rejection.type === "invalid_request_error" ||
      rejection.upstream?.type === "invalid_request_error")
  )
    return "request_invalid"
  if (status === 401 || status === 403) return "provider_auth"
  if (status === 429) return "rate_limited"
  if (status !== undefined && retryableStatus(status)) return "provider_unavailable"
  return "provider_error"
}

/**
 * A non-OK HTTP status, carrying the retry-after headers and — when the caller
 * could read one — what the provider actually said, clipped. A bare status is
 * nearly useless for a 400: the reason a request was rejected lives only in
 * its body.
 */
export class ProviderStatusError extends HttpStatusError {
  readonly detail: string | undefined

  constructor(options: {
    /** Names the provider: "<label> request failed with status 400: …". */
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
      // Classified on the whole body read, not the clipped text: clipping can
      // cut a JSON body, and then its fields could not be read.
      code: options.classify(options.status, options.detail)
    })
    this.detail = clipped
  }
}
