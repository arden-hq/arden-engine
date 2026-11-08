import { countOf } from "@arden-hq/std/count"
import type { Automation } from "@arden-hq/protocol/automations"
import { effectiveBackgroundLimit } from "@arden-hq/protocol/settings"
import { Effect } from "effect"
import type { LimitSettingsStore } from "../persistence/settings/store.js"
import { toolFailure } from "./tool-failure.js"

const keep = (given: number | null | undefined, previous: number | null | undefined) =>
  given === undefined ? (previous ?? null) : given

export const setAutomationLimits = async (
  limits: LimitSettingsStore["Service"],
  automation: Automation,
  automationRef: string,
  input: {
    readonly pause_at_percent: number | null | undefined
    readonly max_tokens_per_run: number | null | undefined
    readonly signal: AbortSignal
  }
) => {
  const failure = (error: Parameters<typeof toolFailure>[0]) =>
    toolFailure(error, "Limits not saved")
  const before = await Effect.runPromise(limits.settings().pipe(Effect.mapError(failure)), {
    signal: input.signal
  })
  const previous = before.automationLimits[automation.task_id]
  const settings = await Effect.runPromise(
    limits
      .updateSettings({
        automationLimit: {
          automationId: automation.task_id,
          pauseAtPercent: keep(input.pause_at_percent, previous?.pauseAtPercent),
          maxTokensPerRun: keep(input.max_tokens_per_run, previous?.maxTokensPerRun)
        }
      })
      .pipe(Effect.mapError(failure)),
    { signal: input.signal }
  )
  const own = settings.automationLimits[automation.task_id]
  const background = effectiveBackgroundLimit(settings)
  const ownPause = own?.pauseAtPercent ?? undefined
  const ownCap = own?.maxTokensPerRun ?? undefined
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
