import {
  CONDITION_OPERATOR,
  decodeTimeTrigger,
  nextScheduleRunAt as nextTimesRunAt,
  type ScheduleClock,
  type TimeSchedule
} from "@arden-hq/protocol/automations"
import {
  APP_EVENT,
  AUTOMATION_CONDITION,
  LEAD_EVENT,
  TRIGGER_STATE,
  TRIGGER_TYPE,
  type AutomationComparisonCondition,
  type AutomationCondition,
  type AutomationTrigger,
  type CountAutomationTrigger,
  type EventAutomationTrigger,
  type IdleAutomationTrigger
} from "@arden-hq/protocol/automations"
import { Option, Schema } from "effect"
import {
  InvalidAutomationScheduleError,
  type PersonalAutomationTriggers
} from "../persistence/automations/model.js"
import { eventTriggerIssue } from "./event-producers.js"

const invalidSchedule = (): never => {
  throw new InvalidAutomationScheduleError("The Automation schedule is invalid")
}

const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const decodePositiveInt = Schema.decodeUnknownOption(PositiveIntSchema)

const comparisonWithValue = (
  condition: Exclude<AutomationComparisonCondition, { readonly op: "exists" }>
): AutomationComparisonCondition =>
  condition.op === CONDITION_OPERATOR.in
    ? { kind: "compare", field: condition.field, op: condition.op, value: condition.value }
    : { kind: "compare", field: condition.field, op: condition.op, value: condition.value }

const normalizeCondition = (condition: AutomationCondition): AutomationCondition => {
  switch (condition.kind) {
    case AUTOMATION_CONDITION.compare:
      return condition.op === CONDITION_OPERATOR.exists
        ? { kind: "compare", field: condition.field, op: condition.op }
        : comparisonWithValue(condition)
    case AUTOMATION_CONDITION.not:
      return { kind: "not", condition: normalizeCondition(condition.condition) }
    case AUTOMATION_CONDITION.and:
    case AUTOMATION_CONDITION.or:
      return {
        kind: condition.kind,
        conditions: condition.conditions.map(normalizeCondition)
      }
  }
}

const normalizedEvent = (trigger: EventAutomationTrigger): EventAutomationTrigger => {
  const filters = {
    run_only_if: trigger.run_only_if,
    condition:
      trigger.condition.kind === TRIGGER_STATE.old
        ? { kind: TRIGGER_STATE.old, condition: normalizeCondition(trigger.condition.condition) }
        : trigger.condition
  }
  if (trigger.event_type === LEAD_EVENT)
    return {
      id: trigger.id,
      type: "event",
      event_type: trigger.event_type,
      lead: trigger.lead,
      ...filters
    }
  if (trigger.event_type === APP_EVENT)
    return {
      id: trigger.id,
      type: "event",
      event_type: trigger.event_type,
      mcp_event: {
        server: trigger.mcp_event.server,
        event: trigger.mcp_event.event,
        arguments: trigger.mcp_event.arguments
      },
      ...filters
    }
  return { id: trigger.id, type: "event", event_type: trigger.event_type, ...filters }
}

export const personalAutomationTriggers = (
  triggers: ReadonlyArray<AutomationTrigger>
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
      case TRIGGER_TYPE.time: {
        const { stored, schedule } = decodeTimeTrigger(trigger.schedule) ?? invalidSchedule()
        times.push(schedule)
        normalized.push({ id: trigger.id, type: "time", schedule: stored })
        break
      }
      case TRIGGER_TYPE.idle: {
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
        idle = { id: trigger.id, type: "idle", idle_minutes: minutes.value }
        normalized.push(idle)
        break
      }
      case TRIGGER_TYPE.count: {
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
        count = { id: trigger.id, type: "count", every_n: everyN.value }
        normalized.push(count)
        break
      }
      case TRIGGER_TYPE.event: {
        const event = normalizedEvent(trigger)
        const issue = eventTriggerIssue(event)
        if (issue !== null) throw new InvalidAutomationScheduleError(issue)
        normalized.push(event)
        break
      }
    }
  }
  return { triggers: normalized, times, idle, count }
}

export const nextScheduleRunAt = (
  schedule: Pick<PersonalAutomationTriggers, "times">,
  clock: ScheduleClock
): number | null => nextTimesRunAt(schedule.times, clock)

export const oneShotSchedule = (schedule: Pick<PersonalAutomationTriggers, "times">): boolean =>
  schedule.times.length > 0 &&
  schedule.times.every(
    (time) => time.kind === TRIGGER_STATE.once || time.kind === TRIGGER_STATE.next
  )
