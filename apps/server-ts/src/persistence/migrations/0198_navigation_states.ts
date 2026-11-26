import { parseJsonText } from "@arden-hq/protocol/common"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const KIND = {
  session: "session",
  settings: "settings",
  automation: "automation",
  memory: "memory",
  work: "work"
} as const

const todayDestination = (destination: Json): Json => {
  const { kind } = destination
  switch (kind) {
    case KIND.session: {
      if (isObject(destination["turn"])) return destination
      const { turn_id, ...rest } = destination
      const turn = text(turn_id)
      return {
        ...rest,
        turn: turn === undefined ? { kind: "latest" } : { kind: "turn", turn_id: turn }
      }
    }
    case KIND.settings: {
      if (isObject(destination["tab"])) return destination
      const tab = text(destination["tab"])
      return {
        ...destination,
        tab: tab === undefined ? { kind: "general" } : { kind: "tab", tab_id: tab }
      }
    }
    case KIND.automation: {
      if (isObject(destination["target"])) return destination
      const { task_id, ...rest } = destination
      const id = text(task_id)
      return {
        ...rest,
        target: id === undefined ? { kind: "list" } : { kind: "automation", task_id: id }
      }
    }
    case KIND.memory: {
      if (isObject(destination["target"])) return destination
      const { path, ...rest } = destination
      const page = text(path)
      return {
        ...rest,
        target: page === undefined ? { kind: "index" } : { kind: "page", path: page }
      }
    }
    case KIND.work: {
      const item = text(destination["item_id"])
      return item === undefined ? { kind: "home" } : { kind: "task", item_id: item }
    }
    default:
      return destination
  }
}

export const todayNavigation = (event: Json): Json => {
  if (isObject(event["asked_by"])) return event
  const { tool_call_id, mode, destination, ...rest } = event
  const call = text(tool_call_id)
  return {
    ...rest,
    destination: isObject(destination) ? todayDestination(destination) : destination,
    mode: mode === undefined ? "open" : mode,
    asked_by: call === undefined ? { kind: "untracked" } : { kind: "tool_call", tool_call_id: call }
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
       WHERE event_type = 'navigation_requested' AND json_valid(data_json)`
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
    const next = JSON.stringify(todayNavigation(event))
    if (next !== stored) update.run(next, row["stream_id"] ?? null, row["sequence"] ?? null)
  }
}

export const navigationStates: Migration = {
  version: 198,
  name: "navigation_states",
  foreignKeys: { kind: "enforced" },
  up
}
