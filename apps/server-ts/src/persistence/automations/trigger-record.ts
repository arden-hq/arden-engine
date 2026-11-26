import {
  APP_EVENT,
  LEAD_EVENT,
  TRIGGER_STATE,
  TRIGGER_TYPE,
  type AutomationTrigger,
  type EventAutomationTrigger,
  type IntervalWindow,
  type TimeTriggerSchedule
} from "@arden-hq/protocol/automations"
import type { JsonValue } from "@arden-hq/protocol"

export type TriggerRecord = { readonly [field: string]: JsonValue }

const windowRecord = (window: IntervalWindow): TriggerRecord => {
  switch (window.kind) {
    case TRIGGER_STATE.all_day:
      return {}
    case TRIGGER_STATE.from:
      return { start: window.start }
    case TRIGGER_STATE.until:
      return { end: window.end }
    case TRIGGER_STATE.between:
      return { start: window.start, end: window.end }
  }
}

const scheduleRecord = (schedule: TimeTriggerSchedule): TriggerRecord => {
  switch (schedule.kind) {
    case TRIGGER_STATE.next:
      return { at: schedule.at }
    case TRIGGER_STATE.once:
      return { at: schedule.at, on: schedule.on }
    case TRIGGER_STATE.daily:
      return { at: schedule.at, days: schedule.days }
    case TRIGGER_STATE.interval:
      return {
        ...(schedule.days.kind === TRIGGER_STATE.days ? { days: schedule.days.days } : {}),
        every: schedule.every,
        ...windowRecord(schedule.window)
      }
  }
}

const eventRecord = (trigger: EventAutomationTrigger): TriggerRecord => ({
  event_type: trigger.event_type,
  ...(trigger.event_type === LEAD_EVENT && trigger.lead.kind === TRIGGER_STATE.minutes
    ? { lead_minutes: trigger.lead.minutes }
    : {}),
  ...(trigger.event_type === APP_EVENT
    ? {
        mcp_event: {
          server: trigger.mcp_event.server,
          event: trigger.mcp_event.event,
          arguments: trigger.mcp_event.arguments
        }
      }
    : {}),
  ...(trigger.condition.kind === TRIGGER_STATE.old
    ? { condition: trigger.condition.condition }
    : {}),
  ...(trigger.run_only_if.kind === TRIGGER_STATE.sentence
    ? { run_only_if: trigger.run_only_if.sentence }
    : {})
})

const fieldsRecord = (trigger: AutomationTrigger): TriggerRecord => {
  switch (trigger.type) {
    case TRIGGER_TYPE.time:
      return scheduleRecord(trigger.schedule)
    case TRIGGER_TYPE.event:
      return eventRecord(trigger)
    case TRIGGER_TYPE.idle:
      return { idle_minutes: trigger.idle_minutes }
    case TRIGGER_TYPE.count:
      return { every_n: trigger.every_n }
  }
}

export const triggerRecord = (trigger: AutomationTrigger): TriggerRecord => ({
  id: trigger.id,
  type: trigger.type,
  ...fieldsRecord(trigger)
})
