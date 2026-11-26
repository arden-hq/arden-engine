import {
  APP_EVENT,
  LEAD_EVENT,
  TRIGGER_TYPE,
  type AutomationTriggerEdit,
  type AutomationTriggerInput,
  type AutomationTriggerSpec,
  type EventLead,
  type EventTriggerEdit,
  type EventTriggerSpec,
  type IntervalWindow,
  type KeptField,
  type McpEventChoice,
  type McpEventSelector,
  type RunOnlyIf,
  type TimeTriggerSchedule,
  type TimeTriggerSpec
} from "@arden-hq/protocol/automations"
import { EVENT_TRIGGER_REFUSAL } from "../persistence/automations/model.js"
import type {
  ToolEventTriggerSchema,
  ToolTimeTriggerSchema,
  ToolTrigger
} from "./automation-tool-trigger-schema.js"

type ToolTime = (typeof ToolTimeTriggerSchema)["Type"]
type ToolEvent = (typeof ToolEventTriggerSchema)["Type"]

export type ToolTriggers<Trigger> =
  | { readonly kind: "converted"; readonly triggers: ReadonlyArray<Trigger> }
  | { readonly kind: "refused"; readonly message: string }

export type Converted<Trigger> =
  | { readonly kind: "converted"; readonly trigger: Trigger }
  | { readonly kind: "refused"; readonly message: string }

export const CONVERSION = { converted: "converted", refused: "refused" } as const

const KEPT: KeptField = { kind: "kept" }
const ANY_EVENT: RunOnlyIf = { kind: "any_event" }
const DEFAULT_LEAD: EventLead = { kind: "default" }
const refused = (message: string) => ({ kind: CONVERSION.refused, message }) as const
const converted = <Trigger>(trigger: Trigger) => ({ kind: CONVERSION.converted, trigger }) as const

const windowOf = (start: string | undefined, end: string | undefined): IntervalWindow => {
  if (start === undefined) return end === undefined ? { kind: "all_day" } : { kind: "until", end }
  return end === undefined ? { kind: "from", start } : { kind: "between", start, end }
}

const scheduleOf = (trigger: ToolTime): Converted<TimeTriggerSchedule> => {
  if (trigger.at !== undefined) {
    if (trigger.on !== undefined) return converted({ kind: "once", at: trigger.at, on: trigger.on })
    return converted(
      trigger.days === undefined
        ? { kind: "next", at: trigger.at }
        : { kind: "daily", at: trigger.at, days: trigger.days }
    )
  }
  if (trigger.every === undefined) return refused("requires exactly one of at or every")
  return converted({
    kind: "interval",
    every: trigger.every,
    days: trigger.days === undefined ? { kind: "every_day" } : { kind: "days", days: trigger.days },
    window: windowOf(trigger.start, trigger.end)
  })
}

const sentenceOf = (sentence: string | null): RunOnlyIf =>
  sentence === null ? ANY_EVENT : { kind: "sentence", sentence }

const leadOf = (minutes: number | null): EventLead =>
  minutes === null ? DEFAULT_LEAD : { kind: "minutes", minutes }

const newEvent = (trigger: ToolEvent): Converted<EventTriggerSpec> => {
  const filters = {
    run_only_if: sentenceOf(trigger.run_only_if ?? null),
    condition: { kind: "none" } as const
  }
  const app = trigger.mcp_event ?? null
  if (trigger.event_type === LEAD_EVENT)
    return converted({
      type: "event",
      event_type: trigger.event_type,
      lead: leadOf(trigger.lead_minutes ?? null),
      ...filters
    })
  if (trigger.event_type === APP_EVENT)
    return app === null
      ? refused(EVENT_TRIGGER_REFUSAL.missingAppEvent)
      : converted({
          type: "event",
          event_type: trigger.event_type,
          mcp_event: { server: app.server, event: app.event, arguments: app.arguments ?? {} },
          ...filters
        })
  return app === null
    ? converted({ type: "event", event_type: trigger.event_type, ...filters })
    : refused(EVENT_TRIGGER_REFUSAL.misplacedAppEvent(trigger.event_type))
}

const appChoiceOf = (trigger: ToolEvent): Converted<McpEventChoice> => {
  if (trigger.mcp_event === undefined) return converted(KEPT)
  if (trigger.mcp_event === null) return refused(EVENT_TRIGGER_REFUSAL.missingAppEvent)
  const app = trigger.mcp_event
  return converted({
    kind: "chosen",
    server: app.server,
    event: app.event,
    arguments: app.arguments ?? {}
  })
}

const editedEvent = (trigger: ToolEvent): Converted<EventTriggerEdit> => {
  const filters = {
    run_only_if: trigger.run_only_if === undefined ? KEPT : sentenceOf(trigger.run_only_if),
    condition: trigger.condition === undefined ? KEPT : ({ kind: "none" } as const)
  }
  if (trigger.event_type === LEAD_EVENT)
    return converted({
      type: "event",
      event_type: trigger.event_type,
      lead: trigger.lead_minutes === undefined ? KEPT : leadOf(trigger.lead_minutes),
      ...filters
    })
  if (trigger.event_type === APP_EVENT) {
    const app = appChoiceOf(trigger)
    return app.kind === CONVERSION.refused
      ? app
      : converted({
          type: "event",
          event_type: trigger.event_type,
          mcp_event: app.trigger,
          ...filters
        })
  }
  return trigger.mcp_event === undefined || trigger.mcp_event === null
    ? converted({ type: "event", event_type: trigger.event_type, ...filters })
    : refused(EVENT_TRIGGER_REFUSAL.misplacedAppEvent(trigger.event_type))
}

const timeOf = (trigger: ToolTime): Converted<TimeTriggerSpec> => {
  const schedule = scheduleOf(trigger)
  return schedule.kind === CONVERSION.refused
    ? schedule
    : converted({ type: TRIGGER_TYPE.time, schedule: schedule.trigger })
}

const specOf = (trigger: ToolTrigger): Converted<AutomationTriggerSpec> => {
  switch (trigger.type) {
    case TRIGGER_TYPE.time:
      return timeOf(trigger)
    case TRIGGER_TYPE.event:
      return newEvent(trigger)
    case TRIGGER_TYPE.idle:
      return converted({ type: trigger.type, idle_minutes: trigger.idle_minutes })
    case TRIGGER_TYPE.count:
      return converted({ type: trigger.type, every_n: trigger.every_n })
  }
}

const editOf = (trigger: ToolTrigger): Converted<AutomationTriggerEdit> => {
  switch (trigger.type) {
    case TRIGGER_TYPE.time:
      return timeOf(trigger)
    case TRIGGER_TYPE.event:
      return editedEvent(trigger)
    case TRIGGER_TYPE.idle:
      return converted({ type: trigger.type, idle_minutes: trigger.idle_minutes })
    case TRIGGER_TYPE.count:
      return converted({ type: trigger.type, every_n: trigger.every_n })
  }
}

export const newTriggerInput = (trigger: ToolTrigger): Converted<AutomationTriggerInput> => {
  const spec = specOf(trigger)
  return spec.kind === CONVERSION.refused ? spec : converted({ kind: "new", trigger: spec.trigger })
}

export const toolTriggerInput = (trigger: ToolTrigger): Converted<AutomationTriggerInput> => {
  if (trigger.id === undefined) return newTriggerInput(trigger)
  const id = trigger.id
  const edit = editOf(trigger)
  return edit.kind === CONVERSION.refused
    ? edit
    : converted({ kind: "edit", id, trigger: edit.trigger })
}

const all = <Trigger>(
  triggers: ReadonlyArray<ToolTrigger>,
  convert: (trigger: ToolTrigger) => Converted<Trigger>
): ToolTriggers<Trigger> => {
  const out: Array<Trigger> = []
  for (const trigger of triggers) {
    const result = convert(trigger)
    if (result.kind === CONVERSION.refused) return result
    out.push(result.trigger)
  }
  return { kind: CONVERSION.converted, triggers: out }
}

export const toolTriggerSpecs = (
  triggers: ReadonlyArray<ToolTrigger>
): ToolTriggers<AutomationTriggerSpec> => all(triggers, specOf)

export const toolTriggerInputs = (
  triggers: ReadonlyArray<ToolTrigger>
): ToolTriggers<AutomationTriggerInput> => all(triggers, toolTriggerInput)

export type CardTrigger = { readonly input: AutomationTriggerInput; readonly appless: boolean }

const UNNAMED_APP = { server: "", event: "" } as const

const withoutApp = (trigger: ToolEvent): ToolEvent => {
  const { mcp_event: _app, ...rest } = trigger
  return rest
}

const cardEvent = (
  trigger: ToolEvent,
  storedApp: (id: string) => McpEventSelector | undefined
): { readonly trigger: ToolEvent; readonly appless: boolean } => {
  if (trigger.event_type !== APP_EVENT) return { trigger: withoutApp(trigger), appless: false }
  const stored = trigger.id === undefined ? undefined : storedApp(trigger.id)
  if (trigger.mcp_event === null || (trigger.mcp_event === undefined && stored === undefined))
    return { trigger: { ...trigger, mcp_event: stored ?? UNNAMED_APP }, appless: true }
  return { trigger, appless: false }
}

export const cardTriggers = (
  triggers: ReadonlyArray<ToolTrigger>,
  convert: (trigger: ToolTrigger) => Converted<AutomationTriggerInput>,
  storedApp: (id: string) => McpEventSelector | undefined
): ReadonlyArray<CardTrigger> =>
  triggers.flatMap((trigger) => {
    const shown =
      trigger.type === TRIGGER_TYPE.event
        ? cardEvent(trigger, storedApp)
        : { trigger, appless: false }
    const input = convert(shown.trigger)
    return input.kind === CONVERSION.converted
      ? [{ input: input.trigger, appless: shown.appless }]
      : []
  })
