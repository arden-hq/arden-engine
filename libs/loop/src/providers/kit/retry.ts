import { backoffDelayMs, parseRetryAfter, retryAfterHints } from "@arden-hq/std/retry"
import { sleep } from "@arden-hq/std/sleep"

import { abortError } from "../../abort.js"
import { HttpStatusError, ProviderError } from "./errors.js"

/** Total connection attempts per request (the pre-emission 401 auth retry is excluded). */
export const DEFAULT_MAX_ATTEMPTS = 5
const RETRY_MAX_DELAY_MS = 30_000
const BACKOFF = { initialMs: 250, maxMs: RETRY_MAX_DELAY_MS, jitter: 0.25 }

const RETRYABLE_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /overloaded|service unavailable|too many requests|rate limit/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|connection (?:error|refused|reset|lost)|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i
]

const matchesRetryableMessage = (value: unknown): boolean =>
  typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))

/**
 * A classified failure retries by its own `retryable` (408/429/5xx statuses and
 * transport failures do; semantic rejections and other 4xx do not). An
 * unclassified Error retries when its message names a transport failure
 * (connection resets, timeouts, overload-style fetch errors).
 */
export const isRetryableFailure = (error: unknown): boolean => {
  if (error instanceof ProviderError) return error.retryable
  return error instanceof Error && matchesRetryableMessage(error.message)
}

const cap = (ms: number): number => Math.min(RETRY_MAX_DELAY_MS, Math.ceil(ms))

const retryAfterDelayMs = (error: unknown): number | undefined => {
  if (!(error instanceof HttpStatusError)) return undefined
  const asked = parseRetryAfter(error)
  return asked === undefined ? undefined : cap(asked)
}

/**
 * Delay before retry `attempt` (1-based): response headers win, then the SSE
 * wire `retry:` hint, then exponential backoff.
 */
export const retryDelayMs = (
  attempt: number,
  error: unknown,
  wireHintMs?: number,
  random = Math.random()
): number => {
  const directed = retryAfterDelayMs(error)
  if (directed !== undefined) return directed
  if (wireHintMs !== undefined) return cap(wireHintMs)
  return backoffDelayMs(BACKOFF, attempt, random)
}

/** Backoff sleep that the abort signal cancels immediately with the loop's AbortError. */
export const backoffSleep = (delayMs: number, signal?: AbortSignal): Promise<void> =>
  sleep(delayMs, signal).catch(() => {
    throw abortError()
  })

/**
 * The one retry decision: the delay before attempt `attempt + 1` when the
 * failure is a transient one and the budget allows another try, else
 * undefined (the failure stands).
 */
export const nextRetry = (
  attempt: number,
  error: unknown,
  options: { readonly maxAttempts?: number; readonly wireHintMs?: number | undefined } = {}
): number | undefined =>
  attempt < (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) && isRetryableFailure(error)
    ? retryDelayMs(attempt, error, options.wireHintMs)
    : undefined

/**
 * `fetch` with the transport retry, for a model endpoint called with one JSON
 * request (embeddings, decision models, a local model server). A dropped
 * connection or a 408/429/5xx answer is tried again under `nextRetry`; the
 * request's own signal bounds every attempt and every wait, so a caller's
 * timeout still holds. The last answer is returned as it came, so the caller
 * reads its status as before. Only a body that can be sent again (none, or a
 * string) is retried.
 */
export const retryingFetch =
  (fetch: typeof globalThis.fetch, maxAttempts = DEFAULT_MAX_ATTEMPTS): typeof globalThis.fetch =>
  async (input, init) => {
    const replayable =
      !(input instanceof Request) &&
      (init?.body === undefined || init.body === null || typeof init.body === "string")
    for (let attempt = 1; ; attempt += 1) {
      let failure: unknown
      try {
        const response = await fetch(input, init)
        if (response.ok || !replayable) return response
        failure = new HttpStatusError(`HTTP ${String(response.status)}`, {
          status: response.status,
          ...retryAfterHints(response.headers),
          code: "provider_unavailable"
        })
        const delayMs = nextRetry(attempt, failure, { maxAttempts })
        if (delayMs === undefined) return response
        await response.body?.cancel().catch(() => undefined)
        await backoffSleep(delayMs, init?.signal ?? undefined)
        continue
      } catch (error) {
        if (failure !== undefined || init?.signal?.aborted || !replayable) throw error
        const delayMs = nextRetry(attempt, error, { maxAttempts })
        if (delayMs === undefined) throw error
        await backoffSleep(delayMs, init?.signal ?? undefined)
      }
    }
  }

/**
 * A one-shot model call with the transport retry: `run` again after a
 * transient failure under `nextRetry`, for a call that is not a plain fetch
 * (a multipart upload over node:http). The signal bounds every attempt and
 * wait. A non-OK answer must throw an HttpStatusError for its status to count.
 */
export const retrying = async <T>(
  run: () => Promise<T>,
  signal: AbortSignal | undefined,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (signal?.aborted) throw error
      const delayMs = nextRetry(attempt, error, { maxAttempts })
      if (delayMs === undefined) throw error
      await backoffSleep(delayMs, signal)
    }
  }
}
