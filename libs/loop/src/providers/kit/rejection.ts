import { isRecord } from "@arden-hq/std/json"
import { retryableStatus } from "@arden-hq/std/retry"
import { clipLine } from "@arden-hq/std/text"

import type { ProviderErrorCode } from "../../errors.js"
import { HttpStatusError } from "./errors.js"

/** How much of a rejection body is worth carrying into the error message. */
export const MAX_STATUS_DETAIL_CHARS = 600

/**
 * What a provider said when it refused a request: the HTTP status (absent for
 * an error frame inside a stream that carries none), the `error.code`,
 * `error.type` and `error.message` of an OpenAI-style body, and `text`, the
 * whole body, searched for overflow prose.
 */
export interface Rejection {
  readonly status: number | undefined
  readonly code: string | undefined
  readonly type: string | undefined
  readonly message: string | undefined
  readonly text: string | undefined
}

/**
 * A context overflow, in the wording each server we talk to uses. One table
 * for every adapter, so the host sees one class however a server words it
 * (taken from prime `utils_inner/overflow.rs`, limited to OpenAI, OpenRouter,
 * llama.cpp, LM Studio, Ollama and generic gateways).
 */
const CONTEXT_OVERFLOW_PROSE: ReadonlyArray<RegExp> = [
  // OpenAI omits the `context_length_exceeded` code on some rejections and
  // says it in prose; LM Studio says "greater than the context length".
  /context (?:length|window)/i,
  /maximum context length is \d+ tokens/i, // OpenRouter, every backend
  /exceeds the model's maximum context length/i, // LiteLLM and gateways in front of it
  /exceeds the available context size/i, // llama.cpp `llama-server`
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /prompt is too long/i, // Anthropic, as OpenRouter relays it
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  // A request body over the server's byte limit can never succeed on retry either.
  /request[_ ](?:body|entity)[_ ](?:is[_ ])?too[_ ]large/i,
  /payload too large/i
]

/** Rate-limit wording ("Too many tokens, please wait") is a throttle, never an overflow. */
const NOT_OVERFLOW_PROSE: ReadonlyArray<RegExp> = [/rate limit/i, /too many requests/i]

/**
 * A refusal of the model itself, in prose. The Codex backend answers a model
 * the ChatGPT sign-in may not use with a bare `{"detail": "The '<model>'
 * model is not supported when using Codex with a ChatGPT account."}`, the
 * Platform API says "The model `<model>` does not exist or you do not have
 * access to it.", and llama.cpp says "model '<model>' not found". Only the
 * provider's own sentence is read, never the request echo around it.
 */
const MODEL_UNAVAILABLE_PROSE =
  /\bmodel\b.{0,80}?\b(?:is not supported|does not exist|is not available|not found)\b/i

/**
 * The overflow signals, structured first: OpenAI's `context_length_exceeded`
 * code, llama.cpp's `exceed_context_size_error` type, any HTTP 413, then prose.
 */
export const isContextOverflow = (rejection: Rejection): boolean => {
  if (rejection.code === "context_length_exceeded") return true
  if (rejection.type === "exceed_context_size_error") return true
  if (rejection.status === 413) return true
  const text = rejection.text ?? rejection.message
  if (text === undefined) return false
  if (NOT_OVERFLOW_PROSE.some((pattern) => pattern.test(text))) return false
  return CONTEXT_OVERFLOW_PROSE.some((pattern) => pattern.test(text))
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** The `error` (or FastAPI-style `detail`) fields of a decoded rejection body. */
export const rejectionFields = (body: unknown): Pick<Rejection, "code" | "type" | "message"> => {
  const record = isRecord(body) ? body : undefined
  const error = isRecord(record?.error) ? record.error : undefined
  return {
    code: stringOf(error?.code),
    type: stringOf(error?.type),
    message: stringOf(error?.message) ?? stringOf(record?.detail)
  }
}

/** A rejection read from an HTTP status and the body text, JSON or not. */
export const httpRejection = (status: number, detail: string | undefined): Rejection => {
  const decoded = parseJson(detail)
  return { status, ...rejectionFields(decoded), text: detail }
}

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
  if (status === 400 && rejection.type === "invalid_request_error") return "request_invalid"
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
      code: options.classify(options.status, clipped)
    })
    this.detail = clipped
  }
}
