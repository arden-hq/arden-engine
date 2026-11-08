import { hasPlanCredits, type PlanCredits, type PlanLimitsReport } from "@arden-hq/protocol/runs"
import { effectiveBackgroundLimit, type LimitSettings } from "@arden-hq/protocol/settings"
import { iso } from "../runtime/clock.js"

export interface PlanWindowReading {
  readonly usedPercent: number
  readonly windowSeconds: number
  readonly resetsAt: number
}

export interface PlanReading {
  readonly provider: string
  readonly plan: string | undefined
  readonly windows: ReadonlyArray<PlanWindowReading>
  readonly credits: PlanCredits | undefined
  readonly observedAt: number
}

export interface PlanLimitsSource {
  readonly latest: () => PlanReading | undefined
  readonly history: () => ReadonlyArray<PlanReading>
  readonly refresh: (signal: AbortSignal) => Promise<PlanReading | undefined>
  readonly onReading: (listener: () => void) => () => void
}

export const nextPlanReset = (reading: PlanReading | undefined, now: number): number | undefined =>
  reading?.windows
    .map((window) => window.resetsAt)
    .filter((resetsAt) => resetsAt > now)
    .reduce<number | undefined>(
      (soonest, resetsAt) => (soonest === undefined ? resetsAt : Math.min(soonest, resetsAt)),
      undefined
    )

const STALE_MS = 60_000
const REFRESH_TIMEOUT_MS = 5_000

export const currentPlanReading = async (
  source: PlanLimitsSource,
  now: number
): Promise<PlanReading | undefined> => {
  const latest = source.latest()
  if (latest !== undefined && now - latest.observedAt < STALE_MS) return latest
  try {
    return (await source.refresh(AbortSignal.timeout(REFRESH_TIMEOUT_MS))) ?? latest
  } catch {
    return latest
  }
}

export type QuotaClass = "interactive" | "background"

export type QuotaPauseReason = "plan_used_up" | "arden_limit" | "background_limit" | "item_limit"

export type QuotaDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "pause"; readonly reason: QuotaPauseReason; readonly until: number }

export interface QuotaLimits {
  readonly ardenLimitPercent: number | undefined
  readonly backgroundLimitPercent: number | undefined
  readonly keepGoingUntil: number | undefined
}

export const quotaDecision = (input: {
  readonly reading: PlanReading | undefined
  readonly limits: QuotaLimits
  readonly quotaClass: QuotaClass
  readonly itemLimitPercent: number | undefined
  readonly now: number
}): QuotaDecision => {
  const { reading, limits, quotaClass, itemLimitPercent, now } = input
  if (reading === undefined) return { kind: "admit" }
  const keepGoing = limits.keepGoingUntil !== undefined && limits.keepGoingUntil > now
  const threshold = (): {
    readonly percent: number | undefined
    readonly reason: QuotaPauseReason
  } => {
    if (quotaClass === "interactive")
      return { percent: keepGoing ? undefined : limits.ardenLimitPercent, reason: "arden_limit" }
    return [
      { percent: limits.ardenLimitPercent, reason: "arden_limit" as const },
      { percent: limits.backgroundLimitPercent, reason: "background_limit" as const },
      { percent: itemLimitPercent, reason: "item_limit" as const }
    ].reduce((lowest, candidate) =>
      candidate.percent !== undefined &&
      (lowest.percent === undefined || candidate.percent < lowest.percent)
        ? candidate
        : lowest
    )
  }
  const { percent, reason } = threshold()
  const blocking = reading.windows.flatMap((window) => {
    if (window.resetsAt <= now) return []
    if (window.usedPercent >= 100 && !hasPlanCredits(reading.credits))
      return [{ reason: "plan_used_up" as const, until: window.resetsAt }]
    return percent !== undefined && window.usedPercent >= percent
      ? [{ reason, until: window.resetsAt }]
      : []
  })
  if (blocking.length === 0) return { kind: "admit" }
  const last = blocking.reduce((a, b) => (b.until > a.until ? b : a))
  const usedUp = blocking.some((block) => block.reason === "plan_used_up")
  return { kind: "pause", reason: usedUp ? "plan_used_up" : last.reason, until: last.until }
}

export const quotaLimits = (settings: LimitSettings): QuotaLimits => ({
  ardenLimitPercent: settings.ardenLimitPercent ?? undefined,
  backgroundLimitPercent: settings.backgroundLimitPercent ?? undefined,
  keepGoingUntil: settings.keepGoingUntil === null ? undefined : Date.parse(settings.keepGoingUntil)
})

export const automationLimitPercent = (
  settings: LimitSettings,
  automationId: string | undefined
): number | undefined =>
  automationId === undefined
    ? undefined
    : (settings.automationLimits[automationId]?.pauseAtPercent ?? undefined)

interface WindowPace {
  readonly elapsedShare: number
  readonly pacePercent: number
  readonly ahead: boolean
  readonly reachesLimitAt: number | undefined
}

const HOUR = 3_600_000

const recentRate = (
  window: PlanWindowReading,
  history: ReadonlyArray<{ readonly at: number; readonly usedPercent: number }>,
  elapsedMs: number,
  now: number
): number => {
  const span = window.windowSeconds <= 5 * 3600 ? HOUR : 24 * HOUR
  const first = history.find((point) => point.at >= now - span)
  if (first !== undefined && now > first.at) {
    const rise = window.usedPercent - first.usedPercent
    if (rise >= 3 || now - first.at >= span / 8) return rise / (now - first.at)
  }
  return elapsedMs > 0 ? window.usedPercent / elapsedMs : 0
}

const windowPace = (input: {
  readonly window: PlanWindowReading
  readonly history: ReadonlyArray<{ readonly at: number; readonly usedPercent: number }>
  readonly limitPercent: number
  readonly now: number
}): WindowPace => {
  const { window, history, limitPercent, now } = input
  const length = window.windowSeconds * 1000
  const elapsedShare = Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / length))
  const pacePercent = limitPercent * elapsedShare
  const ahead = elapsedShare >= 0.1 && window.usedPercent > pacePercent + 5
  const perMs = recentRate(window, history, elapsedShare * length, now)
  const left = limitPercent - window.usedPercent
  const reachesAt = perMs > 0 && left > 0 ? now + left / perMs : undefined
  return {
    elapsedShare,
    pacePercent,
    ahead,
    reachesLimitAt: reachesAt !== undefined && reachesAt < window.resetsAt ? reachesAt : undefined
  }
}

const windowHistory = (
  history: ReadonlyArray<PlanReading>,
  window: PlanWindowReading
): ReadonlyArray<{ readonly at: number; readonly usedPercent: number }> =>
  history.flatMap((reading) =>
    reading.windows
      .filter(
        (earlier) =>
          earlier.windowSeconds === window.windowSeconds &&
          Math.abs(earlier.resetsAt - window.resetsAt) < HOUR
      )
      .map((earlier) => ({ at: reading.observedAt, usedPercent: earlier.usedPercent }))
  )

export const planLimitsReport = (
  reading: PlanReading | undefined,
  history: ReadonlyArray<PlanReading>,
  limitPercent: number,
  now: number
): PlanLimitsReport => ({
  plans:
    reading === undefined
      ? []
      : [
          {
            provider: reading.provider,
            plan: reading.plan ?? null,
            credits: reading.credits ?? null,
            windows: reading.windows.map((window) => {
              const pace = windowPace({
                window,
                history: windowHistory(history, window),
                limitPercent,
                now
              })
              return {
                used_percent: window.usedPercent,
                window_seconds: window.windowSeconds,
                resets_at: iso(window.resetsAt),
                pace: {
                  limit_percent: limitPercent,
                  elapsed_percent: Math.round(pace.elapsedShare * 1000) / 10,
                  on_pace_percent: Math.round(pace.pacePercent * 10) / 10,
                  ahead: pace.ahead,
                  reaches_limit_at:
                    pace.reachesLimitAt === undefined ? null : iso(pace.reachesLimitAt)
                }
              }
            }),
            observed_at: iso(reading.observedAt)
          }
        ]
})

export interface PlanLimitNotice {
  readonly level: "background" | "arden" | "used_up"
  readonly usedPercent: number
  readonly limitPercent: number | null
  readonly windowSeconds: number
  readonly resetsAt: string
}

export const planLimitNotice = (
  reading: PlanReading | undefined,
  settings: LimitSettings,
  now: number
): PlanLimitNotice | undefined => {
  const window = reading?.windows
    .filter((candidate) => candidate.resetsAt > now)
    .reduce<PlanWindowReading | undefined>(
      (fullest, candidate) =>
        fullest === undefined || candidate.usedPercent > fullest.usedPercent ? candidate : fullest,
      undefined
    )
  if (window === undefined) return undefined
  const arden = settings.ardenLimitPercent
  const background = effectiveBackgroundLimit(settings)
  const base = {
    usedPercent: window.usedPercent,
    windowSeconds: window.windowSeconds,
    resetsAt: iso(window.resetsAt)
  }
  if (window.usedPercent >= 100 && !hasPlanCredits(reading?.credits))
    return { ...base, level: "used_up", limitPercent: null }
  const keepGoing = settings.keepGoingUntil !== null && Date.parse(settings.keepGoingUntil) > now
  if (arden !== null && window.usedPercent >= arden && !keepGoing)
    return { ...base, level: "arden", limitPercent: arden }
  if (background !== null && window.usedPercent >= background)
    return { ...base, level: "background", limitPercent: background }
  return undefined
}
