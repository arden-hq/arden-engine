import { parseJsonText } from "@arden-hq/protocol/common"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const TRIGGER_TYPE = { time: "time", event: "event" } as const
type TriggerType = (typeof TRIGGER_TYPE)[keyof typeof TRIGGER_TYPE]
const isTriggerType = (value: unknown): value is TriggerType =>
  Object.values<unknown>(TRIGGER_TYPE).includes(value)

const TRIGGER_EVENT = { lead: "event_approaching", app: "mcp.event" } as const
type TriggerEvent = (typeof TRIGGER_EVENT)[keyof typeof TRIGGER_EVENT]
const isTriggerEvent = (value: unknown): value is TriggerEvent =>
  Object.values<unknown>(TRIGGER_EVENT).includes(value)

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const windowOf = (start: string | undefined, end: string | undefined): Json => {
  if (start === undefined) return end === undefined ? { kind: "all_day" } : { kind: "until", end }
  return end === undefined ? { kind: "from", start } : { kind: "between", start, end }
}

const scheduleOf = (trigger: Json): Json | undefined => {
  const at = text(trigger["at"])
  const on = text(trigger["on"])
  const days = text(trigger["days"])
  const every = text(trigger["every"])
  if (every !== undefined)
    return {
      kind: "interval",
      every,
      days: days === undefined ? { kind: "every_day" } : { kind: "days", days },
      window: windowOf(text(trigger["start"]), text(trigger["end"]))
    }
  if (at === undefined) return undefined
  if (on !== undefined) return { kind: "once", at, on }
  return days === undefined ? { kind: "next", at } : { kind: "daily", at, days }
}

const timeTrigger = (trigger: Json): Json => {
  if (Object.hasOwn(trigger, "schedule")) return trigger
  const schedule = scheduleOf(trigger)
  return schedule === undefined ? trigger : { id: trigger["id"], type: TRIGGER_TYPE.time, schedule }
}

const eventSpecific = (trigger: Json): Json | undefined => {
  const event = trigger["event_type"]
  if (!isTriggerEvent(event)) return {}
  switch (event) {
    case TRIGGER_EVENT.lead: {
      const minutes = trigger["lead_minutes"]
      return {
        lead: typeof minutes === "number" ? { kind: "minutes", minutes } : { kind: "default" }
      }
    }
    case TRIGGER_EVENT.app: {
      const app = trigger["mcp_event"]
      if (!isObject(app)) return undefined
      const args = app["arguments"]
      return {
        mcp_event: {
          server: app["server"],
          event: app["event"],
          arguments: isObject(args) ? args : {}
        }
      }
    }
  }
}

const eventTrigger = (trigger: Json): Json => {
  if (isObject(trigger["run_only_if"])) return trigger
  const specific = eventSpecific(trigger)
  if (specific === undefined) return trigger
  const sentence = text(trigger["run_only_if"])
  const condition = trigger["condition"]
  return {
    id: trigger["id"],
    type: TRIGGER_TYPE.event,
    event_type: trigger["event_type"],
    ...specific,
    run_only_if: sentence === undefined ? { kind: "any_event" } : { kind: "sentence", sentence },
    condition: isObject(condition) ? { kind: "old", condition } : { kind: "none" }
  }
}

export const todayTrigger = (trigger: unknown): unknown => {
  if (!isObject(trigger)) return trigger
  const type = trigger["type"]
  if (!isTriggerType(type)) return trigger
  switch (type) {
    case TRIGGER_TYPE.time:
      return timeTrigger(trigger)
    case TRIGGER_TYPE.event:
      return eventTrigger(trigger)
  }
}

const up = (database: DatabaseSync): void => {
  const rows = database
    .prepare("SELECT task_id, triggers FROM scheduled_tasks WHERE json_valid(triggers)")
    .all()
  const update = database.prepare("UPDATE scheduled_tasks SET triggers = ? WHERE task_id = ?")
  for (const row of rows) {
    const stored = row["triggers"]
    if (typeof stored !== "string") continue
    const triggers = parseJsonText(stored)
    if (!Array.isArray(triggers)) continue
    const next = JSON.stringify(triggers.map(todayTrigger))
    if (next !== JSON.stringify(triggers)) update.run(next, row["task_id"] ?? null)
  }
}

export const triggerStates: Migration = {
  version: 196,
  name: "trigger_states",
  foreignKeys: { kind: "enforced" },
  up
}
