/** A request status worth trying again: timeout, rate limit or server failure. */
export const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

type Backoff = {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor?: number
  readonly jitter?: number
}

/**
 * How long to wait before retry `attempt` (1-based): `initialMs` times `factor`
 * per earlier failure, plus up to `jitter` of it, capped at `maxMs`, in whole
 * milliseconds. `random` is a number in [0, 1).
 */
export const backoffDelayMs = (
  { initialMs, maxMs, factor = 2, jitter = 0 }: Backoff,
  attempt: number,
  random: number = Math.random()
): number => {
  const base = initialMs * factor ** (Math.max(attempt, 1) - 1)
  return Math.min(maxMs, Math.ceil(base + base * jitter * random))
}

/**
 * The hand-picked wait before retry `attempt` (1-based); past the last step the
 * last step repeats.
 */
export const ladderDelayMs = (ladder: ReadonlyArray<number>, attempt: number): number => {
  const step = ladder[Math.min(Math.max(attempt, 1), ladder.length) - 1]
  if (step === undefined) throw new RangeError("A retry ladder needs at least one step")
  return step
}

type RetryAfterHints = {
  readonly retryAfter?: string | null | undefined
  readonly retryAfterMs?: string | null | undefined
}

type HeaderMap = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
type HeaderBag = { get(name: string): string | null } | HeaderMap

const headerValue = (headers: HeaderBag, name: string): string | null => {
  if ("get" in headers && typeof headers.get === "function") return headers.get(name)
  const value = (headers as HeaderMap)[name]
  if (value === undefined) return null
  return typeof value === "string" ? value : (value[0] ?? null)
}

/** `retry-after` and `retry-after-ms` out of fetch `Headers` or a plain header map. */
export const retryAfterHints = (
  headers: HeaderBag
): { readonly retryAfter: string | null; readonly retryAfterMs: string | null } => ({
  retryAfter: headerValue(headers, "retry-after"),
  retryAfterMs: headerValue(headers, "retry-after-ms")
})

const NUMBER = /^\d+(?:\.\d+)?$/

/**
 * What the server asked for, in milliseconds and not capped: `retry-after-ms`,
 * else `retry-after` as seconds or as an HTTP date (a date already past means
 * now, 0). Undefined when neither header says anything usable.
 */
export const parseRetryAfter = (
  hints: RetryAfterHints,
  now: number = Date.now()
): number | undefined => {
  const millis = hints.retryAfterMs?.trim()
  if (millis !== undefined && NUMBER.test(millis)) return Math.ceil(Number(millis))
  const value = hints.retryAfter?.trim()
  if (value === undefined || value === "") return undefined
  if (NUMBER.test(value)) return Math.ceil(Number(value) * 1_000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}
