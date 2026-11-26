import type { JsonValue } from "../common/json.js"
import type { AutomationCondition } from "./contracts.js"
import { AUTOMATION_EVENT_TYPE, type AutomationEventType } from "./triggers.js"

export type TriggerDays =
  | { readonly kind: typeof TRIGGER_STATE.every_day }
  | { readonly kind: typeof TRIGGER_STATE.days; readonly days: string }

export type IntervalWindow =
  | { readonly kind: typeof TRIGGER_STATE.all_day }
  | { readonly kind: typeof TRIGGER_STATE.from; readonly start: string }
  | { readonly kind: typeof TRIGGER_STATE.until; readonly end: string }
  | { readonly kind: typeof TRIGGER_STATE.between; readonly start: string; readonly end: string }

export type TimeTriggerSchedule =
  | { readonly kind: typeof TRIGGER_STATE.next; readonly at: string }
  | { readonly kind: typeof TRIGGER_STATE.once; readonly at: string; readonly on: string }
  | { readonly kind: typeof TRIGGER_STATE.daily; readonly at: string; readonly days: string }
  | {
      readonly kind: typeof TRIGGER_STATE.interval
      readonly every: string
      readonly days: TriggerDays
      readonly window: IntervalWindow
    }

export type EventLead =
  | { readonly kind: typeof TRIGGER_STATE.default }
  | { readonly kind: typeof TRIGGER_STATE.minutes; readonly minutes: number }

export type RunOnlyIf =
  | { readonly kind: typeof TRIGGER_STATE.any_event }
  | { readonly kind: typeof TRIGGER_STATE.sentence; readonly sentence: string }

export type OldEventCondition =
  | { readonly kind: typeof TRIGGER_STATE.none }
  | { readonly kind: typeof TRIGGER_STATE.old; readonly condition: AutomationCondition }

export interface McpEventSelector {
  readonly server: string
  readonly event: string
  readonly arguments: Readonly<Record<string, JsonValue>>
}

export type KeptField = { readonly kind: typeof TRIGGER_STATE.kept }

export type McpEventChoice =
  | KeptField
  | ({ readonly kind: typeof TRIGGER_STATE.chosen } & McpEventSelector)

export const TRIGGER_TYPE = {
  time: "time",
  event: "event",
  idle: "idle",
  count: "count"
} as const

export const TRIGGER_STATE = {
  next: "next",
  once: "once",
  daily: "daily",
  interval: "interval",
  every_day: "every_day",
  days: "days",
  all_day: "all_day",
  from: "from",
  until: "until",
  between: "between",
  default: "default",
  minutes: "minutes",
  any_event: "any_event",
  sentence: "sentence",
  none: "none",
  old: "old",
  kept: "kept",
  chosen: "chosen"
} as const

export const TRIGGER_INPUT = { new: "new", edit: "edit" } as const

export const LEAD_EVENT = AUTOMATION_EVENT_TYPE.event_approaching
export const APP_EVENT = AUTOMATION_EVENT_TYPE.mcp_event
export type PlainEventType = Exclude<AutomationEventType, typeof LEAD_EVENT | typeof APP_EVENT>

type EventOf<Filter, Lead, App> =
  | ({
      readonly type: typeof TRIGGER_TYPE.event
      readonly event_type: typeof LEAD_EVENT
      readonly lead: Lead
    } & Filter)
  | ({
      readonly type: typeof TRIGGER_TYPE.event
      readonly event_type: typeof APP_EVENT
      readonly mcp_event: App
    } & Filter)
  | ({ readonly type: typeof TRIGGER_TYPE.event; readonly event_type: PlainEventType } & Filter)

type EventFilters = {
  readonly run_only_if: RunOnlyIf
  readonly condition: OldEventCondition
}

type EventFilterEdits = {
  readonly run_only_if: RunOnlyIf | KeptField
  readonly condition: OldEventCondition | KeptField
}

export type TimeTriggerSpec = {
  readonly type: typeof TRIGGER_TYPE.time
  readonly schedule: TimeTriggerSchedule
}
export type EventTriggerSpec = EventOf<EventFilters, EventLead, McpEventSelector>
export type IdleTriggerSpec = {
  readonly type: typeof TRIGGER_TYPE.idle
  readonly idle_minutes: number
}
export type CountTriggerSpec = {
  readonly type: typeof TRIGGER_TYPE.count
  readonly every_n: number
}

export type AutomationTriggerSpec =
  | TimeTriggerSpec
  | EventTriggerSpec
  | IdleTriggerSpec
  | CountTriggerSpec

export type EventTriggerEdit = EventOf<EventFilterEdits, EventLead | KeptField, McpEventChoice>

export type AutomationTriggerEdit =
  | TimeTriggerSpec
  | EventTriggerEdit
  | IdleTriggerSpec
  | CountTriggerSpec

type Stored<Spec> = Spec & { readonly id: string }

export type TimeAutomationTrigger = Stored<TimeTriggerSpec>
export type EventAutomationTrigger = Stored<EventTriggerSpec>
export type IdleAutomationTrigger = Stored<IdleTriggerSpec>
export type CountAutomationTrigger = Stored<CountTriggerSpec>

export type AutomationTrigger =
  | TimeAutomationTrigger
  | EventAutomationTrigger
  | IdleAutomationTrigger
  | CountAutomationTrigger

export type AutomationTriggerInput =
  | { readonly kind: typeof TRIGGER_INPUT.new; readonly trigger: AutomationTriggerSpec }
  | {
      readonly kind: typeof TRIGGER_INPUT.edit
      readonly id: string
      readonly trigger: AutomationTriggerEdit
    }
