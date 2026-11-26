import { parseJsonText } from "@arden-hq/protocol/common"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const ACTIVE = new Set(["pending", "running"])

const tagged = (value: unknown, none: string, kind: string, field: string): Json => {
  const present = text(value)
  return present === undefined ? { kind: none } : { kind, [field]: present }
}

const parentOf = (session: Json): Json => {
  const sessionId = text(session["parent_session_id"])
  if (sessionId === undefined) return { kind: "none" }
  const runId = text(session["parent_run_id"])
  const toolCallId = text(session["parent_tool_call_id"])
  if (runId !== undefined && toolCallId !== undefined)
    return {
      kind: "agent",
      session_id: sessionId,
      run_id: runId,
      tool_call_id: toolCallId,
      step: isObject(session["parent_step"]) ? session["parent_step"] : { kind: "none" }
    }
  return {
    kind: "chat",
    session_id: sessionId,
    message: tagged(session["parent_message_id"], "whole", "message", "message_id")
  }
}

const runOf = (session: Json): Json => {
  const runId = text(session["latest_run_id"]) ?? text(session["active_run_id"])
  const status = text(session["run_status"])
  if (runId === undefined || status === undefined) return { kind: "none" }
  const turnId = text(session["active_turn_id"])
  return ACTIVE.has(status) && turnId !== undefined
    ? { kind: "active", run_id: runId, turn_id: turnId, status }
    : { kind: "settled", run_id: runId, status }
}

const threadOf = (source: unknown): Json => {
  if (!isObject(source)) return { kind: "none" }
  const sessionId = text(source["session_id"])
  if (sessionId === undefined) return { kind: "none" }
  const ref = text(source["session_ref"])
  return ref === undefined
    ? { kind: "gone", session_id: sessionId }
    : { kind: "thread", session_id: sessionId, session_ref: ref }
}

const presentationOf = (presentation: unknown): unknown =>
  isObject(presentation) && presentation["owner"] === null
    ? { ...presentation, owner: { kind: "none" } }
    : presentation

const DROPPED = [
  "last_accessed_at",
  "space_id",
  "origin_automation_id",
  "parent_session_id",
  "parent_run_id",
  "parent_tool_call_id",
  "parent_message_id",
  "parent_step",
  "active_run_id",
  "active_turn_id",
  "latest_run_id",
  "run_status",
  "is_active",
  "run_error_code",
  "run_stop_reason",
  "fork_origin",
  "agent_workspace",
  "summary"
]

export const todaySession = (session: Json): Json => {
  if (isObject(session["run"])) return session
  const kept = Object.fromEntries(Object.entries(session).filter(([key]) => !DROPPED.includes(key)))
  const fork = session["fork"]
  const triage = session["triage"]
  return {
    ...kept,
    presentation: presentationOf(session["presentation"]),
    name: tagged(session["name"], "unnamed", "named", "name"),
    space: tagged(session["space_id"], "none", "space", "space_id"),
    chat_model: tagged(session["chat_model"], "inherited", "pinned", "model_id"),
    session_type: text(session["session_type"]) ?? "chat",
    origin_automation: tagged(
      session["origin_automation_id"],
      "none",
      "automation",
      "automation_id"
    ),
    parent: parentOf(session),
    run: runOf(session),
    has_unread: session["has_unread"] === true,
    triage: isObject(triage) ? { kind: "decided", decision: triage } : { kind: "none" },
    fork: isObject(fork)
      ? { kind: "fork", at: fork["at"], turn_id: fork["turn_id"] }
      : { kind: "none" },
    thread_source: threadOf(session["thread_source"]),
    origin: text(session["origin"]) ?? "ordinary",
    current_activity: { kind: "idle" }
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
       WHERE event_type IN ('session_created', 'session_activity') AND json_valid(data_json)`
    )
    .all()
  const update = database.prepare(
    "UPDATE journal_records SET data_json = ? WHERE stream_id = ? AND sequence = ?"
  )
  for (const row of rows) {
    const stored = row["data_json"]
    if (typeof stored !== "string") continue
    const event = parseJsonText(stored)
    if (!isObject(event) || !isObject(event["session"])) continue
    const next = JSON.stringify({ ...event, session: todaySession(event["session"]) })
    if (next !== stored) update.run(next, row["stream_id"] ?? null, row["sequence"] ?? null)
  }
}

export const sessionSnapshotStates: Migration = {
  version: 200,
  name: "session_snapshot_states",
  foreignKeys: { kind: "enforced" },
  up
}
