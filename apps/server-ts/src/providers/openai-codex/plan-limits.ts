import { Option, Schema } from "effect"
import type { PlanCredits } from "@arden-hq/protocol/runs"
import type { PlanLimitsSource, PlanReading, PlanWindowReading } from "../../models/plan-limits.js"
import { currentMillis } from "../../runtime/clock.js"

const PROVIDER = "openai-codex"
const WINDOWS = ["primary", "secondary"] as const

const finite = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const CreditsSchema = Schema.Struct({
  has_credits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number])))
})

const readCredits = (body: unknown): PlanCredits | undefined => {
  const decoded = Schema.decodeUnknownOption(CreditsSchema)(body)
  if (Option.isNone(decoded)) return undefined
  const credits = decoded.value
  if (credits.unlimited) return { kind: "unlimited" }
  const balance = finite(credits.balance == null ? null : String(credits.balance))
  return {
    kind: "limited",
    available: credits.has_credits,
    balance: balance !== undefined && balance >= 0 ? balance : null
  }
}

const headerBoolean = (value: string | null): boolean | undefined => {
  switch (value?.trim().toLowerCase()) {
    case "true":
    case "1":
      return true
    case "false":
    case "0":
      return false
    case undefined:
    default:
      return undefined
  }
}

const resetTime = (
  resetAt: number | null | undefined,
  resetAfterSeconds: number | null | undefined,
  now: number
): number | undefined => {
  if (resetAt !== undefined && resetAt !== null) return resetAt * 1000
  if (resetAfterSeconds !== undefined && resetAfterSeconds !== null)
    return now + resetAfterSeconds * 1000
  return undefined
}

/**
 * Reads the `x-codex-<window>-*` family every Codex response carries. Returns
 * undefined when the response has none (an error page, another route).
 */
const readCodexHeaders = (
  headers: Headers,
  now: number,
  plan: string | undefined
): PlanReading | undefined => {
  const windows = WINDOWS.flatMap((name): ReadonlyArray<PlanWindowReading> => {
    const used = finite(headers.get(`x-codex-${name}-used-percent`))
    const minutes = finite(headers.get(`x-codex-${name}-window-minutes`))
    const resetsAt = resetTime(
      finite(headers.get(`x-codex-${name}-reset-at`)),
      finite(headers.get(`x-codex-${name}-reset-after-seconds`)),
      now
    )
    // A window of no length is the placeholder Codex sends for a limit the
    // plan does not have (Codex's own reader drops it too).
    if (used === undefined || minutes === undefined || minutes <= 0) return []
    if (resetsAt === undefined) return []
    return [{ usedPercent: used, windowSeconds: minutes * 60, resetsAt }]
  })
  const credits = readCredits({
    has_credits: headerBoolean(headers.get("x-codex-credits-has-credits")),
    unlimited: headerBoolean(headers.get("x-codex-credits-unlimited")),
    balance: headers.get("x-codex-credits-balance")
  })
  if (windows.length === 0 && credits === undefined) return undefined
  return { provider: PROVIDER, plan, windows: shortestFirst(windows), credits, observedAt: now }
}

const WindowSchema = Schema.Struct({
  used_percent: Schema.Number,
  limit_window_seconds: Schema.Number,
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_after_seconds: Schema.optional(Schema.NullOr(Schema.Number))
})

const UsageSchema = Schema.Struct({
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  credits: Schema.optional(Schema.Unknown),
  rate_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        primary_window: Schema.optional(Schema.NullOr(WindowSchema)),
        secondary_window: Schema.optional(Schema.NullOr(WindowSchema))
      })
    )
  )
})

const readCodexUsage = (body: unknown, now: number): PlanReading | undefined => {
  const decoded = Schema.decodeUnknownOption(UsageSchema)(body)
  if (Option.isNone(decoded)) return undefined
  const usage = decoded.value
  const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].flatMap(
    (window): ReadonlyArray<PlanWindowReading> => {
      if (window === undefined || window === null) return []
      const resetsAt = resetTime(window.reset_at, window.reset_after_seconds, now)
      if (resetsAt === undefined || window.limit_window_seconds <= 0) return []
      return [
        { usedPercent: window.used_percent, windowSeconds: window.limit_window_seconds, resetsAt }
      ]
    }
  )
  return {
    provider: PROVIDER,
    plan: usage.plan_type ?? undefined,
    windows: shortestFirst(windows),
    credits: readCredits(usage.credits),
    observedAt: now
  }
}

const EventWindowSchema = Schema.Struct({
  used_percent: Schema.Number,
  window_minutes: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Number))
})
const RateLimitEventSchema = Schema.Struct({
  type: Schema.Literal("codex.rate_limits"),
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  credits: Schema.optional(Schema.Unknown),
  metered_limit_name: Schema.optional(Schema.NullOr(Schema.String)),
  limit_name: Schema.optional(Schema.NullOr(Schema.String)),
  rate_limits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        primary: Schema.optional(Schema.NullOr(EventWindowSchema)),
        secondary: Schema.optional(Schema.NullOr(EventWindowSchema))
      })
    )
  )
})

const readCodexEvent = (
  body: unknown,
  now: number,
  plan: string | undefined
): PlanReading | undefined => {
  const decoded = Schema.decodeUnknownOption(RateLimitEventSchema)(body)
  if (Option.isNone(decoded)) return undefined
  const event = decoded.value
  const limit = event.metered_limit_name ?? event.limit_name
  if (limit !== undefined && limit !== null && limit !== "codex") return undefined
  const windows = [event.rate_limits?.primary, event.rate_limits?.secondary].flatMap(
    (window): ReadonlyArray<PlanWindowReading> => {
      if (
        window?.window_minutes === undefined ||
        window.window_minutes === null ||
        window.window_minutes <= 0 ||
        window.reset_at === undefined ||
        window.reset_at === null
      )
        return []
      return [
        {
          usedPercent: window.used_percent,
          windowSeconds: window.window_minutes * 60,
          resetsAt: window.reset_at * 1000
        }
      ]
    }
  )
  const credits = readCredits(event.credits)
  if (windows.length === 0 && credits === undefined) return undefined
  return {
    provider: PROVIDER,
    plan: event.plan_type ?? plan,
    windows: shortestFirst(windows),
    credits,
    observedAt: now
  }
}

const HISTORY_MS = 8 * 24 * 3_600_000
const HISTORY_LIMIT = 2_000

const shortestFirst = (windows: ReadonlyArray<PlanWindowReading>) =>
  [...windows].sort((left, right) => left.windowSeconds - right.windowSeconds)

export const makeCodexPlanLimits = (
  fetchUsage: (signal: AbortSignal) => Promise<unknown>
): PlanLimitsSource & {
  readonly observingFetch: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch
  readonly observeHeaders: (headers: Headers) => void
  readonly observeEvent: (event: unknown) => void
} => {
  let latest: PlanReading | undefined
  let kept: ReadonlyArray<PlanReading> = []
  const listeners = new Set<() => void>()
  const moved = (reading: PlanReading) =>
    latest === undefined ||
    reading.windows.length !== latest.windows.length ||
    reading.windows.some(
      (window, index) => window.usedPercent !== latest?.windows[index]?.usedPercent
    )
  const keep = (reading: PlanReading | undefined) => {
    if (reading === undefined || (latest !== undefined && reading.observedAt < latest.observedAt))
      return latest
    if (moved(reading))
      kept = [
        ...kept.filter((old) => old.observedAt >= reading.observedAt - HISTORY_MS),
        reading
      ].slice(-HISTORY_LIMIT)
    latest = reading
    for (const listener of listeners) listener()
    return latest
  }
  const observe = (reading: PlanReading | undefined) => {
    if (reading === undefined) return
    keep({
      ...reading,
      windows: reading.windows.length > 0 ? reading.windows : (latest?.windows ?? []),
      credits: reading.credits ?? latest?.credits
    })
  }
  const observeHeaders = (headers: Headers) => {
    observe(readCodexHeaders(headers, currentMillis(), latest?.plan))
  }
  return {
    latest: () => latest,
    history: () => kept,
    onReading: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: async (signal) => keep(readCodexUsage(await fetchUsage(signal), currentMillis())),
    observeHeaders,
    observeEvent: (event) => {
      observe(readCodexEvent(event, currentMillis(), latest?.plan))
    },
    observingFetch: (fetch) => async (input, init) => {
      const response = await fetch(input, init)
      observeHeaders(response.headers)
      return response
    }
  }
}
