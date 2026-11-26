import { parseJsonText } from "@arden-hq/protocol/common"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const LIFECYCLE_EVENT_TYPE = {
  finished: "automation_finished",
  told: "record_told",
  entity: "entity_changed",
  question: "question_changed",
  visibility: "task_visibility_changed",
  work: "work_changed",
  taskWork: "task_work_changed"
} as const
type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPE)[keyof typeof LIFECYCLE_EVENT_TYPE]
const isLifecycleEventType = (value: unknown): value is LifecycleEventType =>
  Object.values<unknown>(LIFECYCLE_EVENT_TYPE).includes(value)

const chat = (id: unknown): Json => {
  const sessionId = text(id)
  return sessionId === undefined ? { kind: "none" } : { kind: "chat", session_id: sessionId }
}
const automation = (id: unknown): Json => {
  const automationId = text(id)
  return automationId === undefined
    ? { kind: "none" }
    : { kind: "automation", automation_id: automationId }
}
const task = (id: unknown): Json => {
  const itemId = text(id)
  return itemId === undefined ? { kind: "none" } : { kind: "task", item_id: itemId }
}
const space = (id: unknown): Json => {
  const spaceId = text(id)
  return spaceId === undefined ? { kind: "none" } : { kind: "space", space_id: spaceId }
}

const endedAs = (error: unknown): string => (text(error) === undefined ? "completed" : "failed")

const withSpace = (event: Json): Json => {
  if (isObject(event["space"])) return event
  const { space_id, ...rest } = event
  return { ...rest, space: space(space_id) }
}

export const todayLifecycleEvent = (event: Json): Json => {
  const type = event["type"]
  if (!isLifecycleEventType(type)) return event
  switch (type) {
    case LIFECYCLE_EVENT_TYPE.finished: {
      if (isObject(event["run_chat"])) return event
      const {
        purpose: _p,
        result: _r,
        error,
        run_id: _id,
        run_session_id,
        outcome,
        ...rest
      } = event
      return {
        ...rest,
        outcome: typeof outcome === "string" ? outcome : endedAs(error),
        run_chat: chat(run_session_id)
      }
    }
    case LIFECYCLE_EVENT_TYPE.told: {
      if (isObject(event["chat"])) return event
      const { chat_session_id, automation_id, item_id, ...rest } = event
      return {
        ...rest,
        chat: chat(chat_session_id),
        automation: automation(automation_id),
        task: task(item_id)
      }
    }
    case LIFECYCLE_EVENT_TYPE.entity: {
      if (isObject(event["target"])) return event
      const { id, ...rest } = event
      const one = text(id)
      return { ...rest, target: one === undefined ? { kind: "many" } : { kind: "one", id: one } }
    }
    case LIFECYCLE_EVENT_TYPE.question: {
      if (isObject(event["task"])) return event
      const { item_id, ...rest } = event
      return { ...rest, task: task(item_id) }
    }
    case LIFECYCLE_EVENT_TYPE.visibility:
    case LIFECYCLE_EVENT_TYPE.work:
    case LIFECYCLE_EVENT_TYPE.taskWork:
      return withSpace(event)
  }
}

const up = (database: DatabaseSync): void => {
  const journal = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'journal_records'"
    )
    .get()
  if (journal === undefined) return
  const rows = database
    .prepare(
      `SELECT stream_id, sequence, data_json FROM journal_records
       WHERE event_type IN (${Object.values(LIFECYCLE_EVENT_TYPE)
         .map((type) => `'${type}'`)
         .join(", ")}) AND json_valid(data_json)`
    )
    .all()
  const update = database.prepare(
    "UPDATE journal_records SET data_json = ? WHERE stream_id = ? AND sequence = ?"
  )
  for (const row of rows) {
    const stored = row["data_json"]
    if (typeof stored !== "string") continue
    const event = parseJsonText(stored)
    if (!isObject(event)) continue
    const next = JSON.stringify(todayLifecycleEvent(event))
    if (next !== stored) update.run(next, row["stream_id"] ?? null, row["sequence"] ?? null)
  }
}

export const lifecycleEventLinks: Migration = {
  version: 199,
  name: "lifecycle_event_links",
  foreignKeys: { kind: "enforced" },
  up
}
