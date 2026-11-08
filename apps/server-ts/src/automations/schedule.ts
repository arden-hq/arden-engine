import {
  decodeTimeTrigger,
  nextScheduleRunAt as nextTimesRunAt,
  type ScheduleClock,
  type TimeSchedule
} from "@arden-hq/protocol/automations"
import type {
  AutomationCondition,
  AutomationConditionInput,
  AutomationTrigger,
  AutomationTriggerInput,
  CountAutomationTrigger,
  IdleAutomationTrigger
} from "@arden-hq/protocol/automations"
import { Option, Schema } from "effect"
import {
  InvalidAutomationScheduleError,
  type PersonalAutomationTriggers
} from "../persistence/automations/model.js"
import { eventTriggerIssue } from "./event-producers.js"

const TimeFieldsSchema = Schema.Struct({
  type: Schema.Literal("time"),
  at: Schema.optionalKey(Schema.Trim),
  on: Schema.optionalKey(Schema.Trim),
  days: Schema.optionalKey(Schema.Trim),
  every: Schema.optionalKey(Schema.Trim),
  start: Schema.optionalKey(Schema.Trim),
  end: Schema.optionalKey(Schema.Trim)
})

const decodeTimeFields = Schema.decodeUnknownOption(TimeFieldsSchema)

const invalidSchedule = (): never => {
  throw new InvalidAutomationScheduleError("The Automation schedule is invalid")
}

const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const decodePositiveInt = Schema.decodeUnknownOption(PositiveIntSchema)

const normalizeCondition = (
  condition: AutomationCondition | AutomationConditionInput
): AutomationCondition => {
  switch (condition.kind) {
    case "compare":
      return {
        kind: "compare",
        field: condition.field,
        op: condition.op,
        ...(condition.value === undefined ? {} : { value: condition.value })
      }
    case "not":
      return { kind: "not", condition: normalizeCondition(condition.condition) }
    case "and":
    case "or":
      return {
        kind: condition.kind,
        conditions: condition.conditions.map(normalizeCondition)
      }
  }
}

export const personalAutomationTriggers = (
  triggers: ReadonlyArray<AutomationTriggerInput | AutomationTrigger>
): PersonalAutomationTriggers => {
  if (triggers.length === 0) {
    throw new InvalidAutomationScheduleError("An Automation requires at least one trigger")
  }
  const times: Array<TimeSchedule> = []
  let idle: IdleAutomationTrigger | null = null
  let count: CountAutomationTrigger | null = null
  const normalized: Array<AutomationTrigger> = []
  for (const trigger of triggers) {
    switch (trigger.type) {
      case "time": {
        const decoded = decodeTimeFields(trigger)
        if (Option.isNone(decoded)) return invalidSchedule()
        const { stored, schedule } = decodeTimeTrigger(decoded.value) ?? invalidSchedule()
        times.push(schedule)
        normalized.push(withId(trigger, stored))
        break
      }
      case "idle": {
        if (idle !== null) {
          throw new InvalidAutomationScheduleError(
            "An Automation can have at most one idle trigger"
          )
        }
        const minutes = decodePositiveInt(trigger.idle_minutes)
        if (Option.isNone(minutes)) {
          throw new InvalidAutomationScheduleError(
            "An idle trigger requires whole positive idle_minutes"
          )
        }
        idle = { type: "idle", idle_minutes: minutes.value }
        normalized.push(withId(trigger, idle))
        break
      }
      case "count": {
        if (count !== null) {
          throw new InvalidAutomationScheduleError(
            "An Automation can have at most one count trigger"
          )
        }
        const everyN = decodePositiveInt(trigger.every_n)
        if (Option.isNone(everyN)) {
          throw new InvalidAutomationScheduleError(
            "A count trigger requires a whole positive every_n"
          )
        }
        count = { type: "count", every_n: everyN.value }
        normalized.push(withId(trigger, count))
        break
      }
      case "event": {
        const event = {
          type: "event" as const,
          event_type: trigger.event_type,
          ...(trigger.lead_minutes === undefined || trigger.lead_minutes === null
            ? {}
            : { lead_minutes: trigger.lead_minutes }),
          ...(trigger.mcp_event === undefined || trigger.mcp_event === null
            ? {}
            : {
                mcp_event: {
                  server: trigger.mcp_event.server,
                  event: trigger.mcp_event.event,
                  arguments: trigger.mcp_event.arguments ?? {}
                }
              }),
          ...(trigger.condition === undefined
            ? {}
            : {
                condition: trigger.condition === null ? null : normalizeCondition(trigger.condition)
              }),
          ...(trigger.run_only_if === undefined || trigger.run_only_if === null
            ? {}
            : { run_only_if: trigger.run_only_if })
        }
        const issue = eventTriggerIssue(event)
        if (issue !== null) throw new InvalidAutomationScheduleError(issue)
        normalized.push(withId(trigger, event))
        break
      }
    }
  }
  return { triggers: normalized, times, idle, count }
}

const withId = <T extends AutomationTrigger>(
  sent: AutomationTriggerInput | AutomationTrigger,
  normalized: T
): T => (sent.id === undefined ? normalized : { ...normalized, id: sent.id })

export const nextScheduleRunAt = (
  schedule: Pick<PersonalAutomationTriggers, "times">,
  clock: ScheduleClock
): number | null => nextTimesRunAt(schedule.times, clock)

export const oneShotSchedule = (schedule: Pick<PersonalAutomationTriggers, "times">): boolean =>
  schedule.times.length > 0 &&
  schedule.times.every((time) => time.kind === "once" || time.kind === "next")
