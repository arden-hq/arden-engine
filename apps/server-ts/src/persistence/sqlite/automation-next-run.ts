import type { AutomationRules, PersonalAutomationTriggers } from "../automations/model.js"
import { iso } from "../../runtime/clock.js"

export const updatedNextRunAt = (input: {
  readonly rules: AutomationRules["Service"]
  readonly enabled: boolean
  readonly rescheduled: boolean
  readonly schedule: Pick<PersonalAutomationTriggers, "times">
  readonly storedNextRunAt: string | null
  readonly nowMs: number
}): string | null => {
  if (!input.enabled) return null
  if (!input.rescheduled) {
    if (input.storedNextRunAt === null) return null
    const carried = Date.parse(input.storedNextRunAt)
    return Number.isFinite(carried) ? iso(carried) : null
  }
  const next = input.rules.nextRunAt(input.schedule, input.nowMs)
  if (next === null || !Number.isFinite(next)) return null
  return iso(next)
}
