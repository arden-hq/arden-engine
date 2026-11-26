export const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

type Backoff = {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor?: number
  readonly jitter?: number
}

export const backoffDelayMs = (
  { initialMs, maxMs, factor = 2, jitter = 0 }: Backoff,
  attempt: number,
  random: number = Math.random()
): number => {
  const base = initialMs * factor ** (Math.max(attempt, 1) - 1)
  return Math.min(maxMs, Math.ceil(base + base * jitter * random))
}

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

export const retryAfterHints = (
  headers: HeaderBag
): { readonly retryAfter: string | null; readonly retryAfterMs: string | null } => ({
  retryAfter: headerValue(headers, "retry-after"),
  retryAfterMs: headerValue(headers, "retry-after-ms")
})

const NUMBER = /^\d+(?:\.\d+)?$/

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
