import type { JsonValue } from "../common/json.js"
import type { AutomationCondition } from "./contracts.js"
import type { AutomationEventType } from "./triggers.js"

export type TriggerDays =
  | { readonly kind: "every_day" }
  | { readonly kind: "days"; readonly days: string }

export type IntervalWindow =
  | { readonly kind: "all_day" }
  | { readonly kind: "from"; readonly start: string }
  | { readonly kind: "until"; readonly end: string }
  | { readonly kind: "between"; readonly start: string; readonly end: string }

export type TimeTriggerSchedule =
  | { readonly kind: "next"; readonly at: string }
  | { readonly kind: "once"; readonly at: string; readonly on: string }
  | { readonly kind: "daily"; readonly at: string; readonly days: string }
  | {
      readonly kind: "interval"
      readonly every: string
      readonly days: TriggerDays
      readonly window: IntervalWindow
    }

export type EventLead =
  | { readonly kind: "default" }
  | { readonly kind: "minutes"; readonly minutes: number }

export type RunOnlyIf =
  | { readonly kind: "any_event" }
  | { readonly kind: "sentence"; readonly sentence: string }

export type OldEventCondition =
  | { readonly kind: "none" }
  | { readonly kind: "old"; readonly condition: AutomationCondition }

export interface McpEventSelector {
  readonly server: string
  readonly event: string
  readonly arguments: Readonly<Record<string, JsonValue>>
}

export type KeptField = { readonly kind: "kept" }

export type McpEventChoice = KeptField | ({ readonly kind: "chosen" } & McpEventSelector)

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

export const LEAD_EVENT = "event_approaching"
export const APP_EVENT = "mcp.event"
export type PlainEventType = Exclude<AutomationEventType, typeof LEAD_EVENT | typeof APP_EVENT>

type EventOf<Filter, Lead, App> =
  | ({
      readonly type: "event"
      readonly event_type: typeof LEAD_EVENT
      readonly lead: Lead
    } & Filter)
  | ({
      readonly type: "event"
      readonly event_type: typeof APP_EVENT
      readonly mcp_event: App
    } & Filter)
  | ({ readonly type: "event"; readonly event_type: PlainEventType } & Filter)

type EventFilters = {
  readonly run_only_if: RunOnlyIf
  readonly condition: OldEventCondition
}

type EventFilterEdits = {
  readonly run_only_if: RunOnlyIf | KeptField
  readonly condition: OldEventCondition | KeptField
}

export type TimeTriggerSpec = { readonly type: "time"; readonly schedule: TimeTriggerSchedule }
export type EventTriggerSpec = EventOf<EventFilters, EventLead, McpEventSelector>
export type IdleTriggerSpec = { readonly type: "idle"; readonly idle_minutes: number }
export type CountTriggerSpec = { readonly type: "count"; readonly every_n: number }

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
  | { readonly kind: "new"; readonly trigger: AutomationTriggerSpec }
  | { readonly kind: "edit"; readonly id: string; readonly trigger: AutomationTriggerEdit }
