import { countOf } from "@arden-hq/std/count"
import type { Automation } from "@arden-hq/protocol/automations"
import {
  effectiveBackgroundLimit,
  LIMIT_SETTINGS_CHANGE,
  PLAN_STOP,
  TOKEN_CAP,
  type AutomationLimit,
  type PlanStop,
  type TokenCap
} from "@arden-hq/protocol/settings"
import { Effect } from "effect"
import type { LimitSettingsStore } from "../persistence/settings/store.js"
import { capTokens, stopPercent } from "../models/plan-limits.js"
import { toolFailure } from "./tool-failure.js"

const UNLIMITED: AutomationLimit = {
  pause: { kind: PLAN_STOP.unlimited },
  cap: { kind: TOKEN_CAP.uncapped }
}

const pauseOf = (percent: number | null): PlanStop =>
  percent === null ? { kind: PLAN_STOP.unlimited } : { kind: PLAN_STOP.at, percent }

const capOf = (tokens: number | null): TokenCap =>
  tokens === null ? { kind: TOKEN_CAP.uncapped } : { kind: TOKEN_CAP.capped, tokens }

const nextLimit = (
  previous: AutomationLimit,
  pause: number | null | undefined,
  cap: number | null | undefined
): AutomationLimit => ({
  pause: pause === undefined ? previous.pause : pauseOf(pause),
  cap: cap === undefined ? previous.cap : capOf(cap)
})

export const setAutomationLimits = async (
  limits: LimitSettingsStore["Service"],
  automation: Automation,
  automationRef: string,
  input: {
    readonly pause_at_percent: number | null | undefined
    readonly max_tokens_per_run: number | null | undefined
    readonly signal: AbortSignal
  }
): Promise<{
  result: string
  preview: string
  data: {
    automation_ref: string
    pause_at_percent: number | null
    effective_pause_at_percent: number | null
    max_tokens_per_run: number | null
  }
}> => {
  const failure = (error: Parameters<typeof toolFailure>[0]) =>
    toolFailure(error, "Limits not saved")
  const before = await Effect.runPromise(limits.settings().pipe(Effect.mapError(failure)), {
    signal: input.signal
  })
  const previous = before.automationLimits[automation.task_id] ?? UNLIMITED
  const settings = await Effect.runPromise(
    limits
      .updateSettings([
        {
          kind: LIMIT_SETTINGS_CHANGE.automationLimit,
          automation: automation.task_id,
          value: nextLimit(previous, input.pause_at_percent, input.max_tokens_per_run)
        }
      ])
      .pipe(Effect.mapError(failure)),
    { signal: input.signal }
  )
  const own = settings.automationLimits[automation.task_id] ?? UNLIMITED
  const background = stopPercent(effectiveBackgroundLimit(settings)) ?? null
  const ownPause = stopPercent(own.pause)
  const ownCap = capTokens(own.cap)
  const pause = (): string => {
    if (background === null)
      return ownPause === undefined
        ? "No plan stop; available credits may be used"
        : `Pauses at ${ownPause}% of the plan`
    if (ownPause === undefined) return `Pauses with the background limit at ${background}%`
    if (ownPause < background) return `Pauses at ${ownPause}% of the plan`
    return `Pauses at ${background}%: its own ${ownPause}% is above the background limit`
  }
  return {
    result: [
      `Plan limits for ${automation.name}`,
      pause(),
      ownCap === undefined ? "No cap per run" : `At most ${countOf(ownCap, "token")} per run`
    ].join("\n"),
    preview: "Limits saved",
    data: {
      automation_ref: automationRef,
      pause_at_percent: ownPause ?? null,
      effective_pause_at_percent:
        ownPause === undefined || (background !== null && background < ownPause)
          ? background
          : ownPause,
      max_tokens_per_run: ownCap ?? null
    }
  }
}
