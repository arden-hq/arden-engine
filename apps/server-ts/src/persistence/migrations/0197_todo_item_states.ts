import { parseJsonText } from "@arden-hq/protocol/common"
import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const CANCELLED = "cancelled"

const reasonOf = (reason: unknown): Json =>
  typeof reason === "string" ? { kind: "stated", text: reason } : { kind: "unstated" }

const todoItem = (item: unknown): unknown => {
  if (!isObject(item) || isObject(item["reason"])) return item
  const { reason, ...rest } = item
  const id = typeof item["id"] === "string" ? item["id"] : randomUUID()
  return item["status"] === CANCELLED ? { ...rest, id, reason: reasonOf(reason) } : { ...rest, id }
}

export const todoItems = (items: unknown): unknown =>
  Array.isArray(items) ? items.map(todoItem) : items

const rewrite = (
  database: DatabaseSync,
  select: string,
  update: string,
  change: (value: unknown) => unknown
): void => {
  const write = database.prepare(update)
  for (const row of database.prepare(select).all()) {
    const stored = row["value"]
    if (typeof stored !== "string") continue
    const next = JSON.stringify(change(parseJsonText(stored)))
    if (next !== stored) write.run(next, row["k1"] ?? null, row["k2"] ?? null)
  }
}

const up = (database: DatabaseSync): void => {
  rewrite(
    database,
    `SELECT items_json AS value, session_id AS k1, edited AS k2 FROM session_todos
     WHERE json_valid(items_json)`,
    "UPDATE session_todos SET items_json = ? WHERE session_id = ? AND edited = ?",
    todoItems
  )
  rewrite(
    database,
    `SELECT result_json AS value, tool_call_id AS k1, run_id AS k2 FROM tool_calls
     WHERE tool_name = 'todo_update' AND result_json IS NOT NULL AND json_valid(result_json)`,
    "UPDATE tool_calls SET result_json = ? WHERE tool_call_id = ? AND run_id = ?",
    (result) =>
      isObject(result) && isObject(result["data"])
        ? { ...result, data: { ...result["data"], items: todoItems(result["data"]["items"]) } }
        : result
  )
  const journal = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'journal_records'"
    )
    .get()
  if (journal === undefined) return
  rewrite(
    database,
    `SELECT data_json AS value, stream_id AS k1, sequence AS k2 FROM journal_records
     WHERE event_type = 'todo_updated' AND json_valid(data_json)`,
    "UPDATE journal_records SET data_json = ? WHERE stream_id = ? AND sequence = ?",
    (event) => (isObject(event) ? { ...event, items: todoItems(event["items"]) } : event)
  )
}

export const todoItemStates: Migration = {
  version: 197,
  name: "todo_item_states",
  foreignKeys: { kind: "enforced" },
  up
}
