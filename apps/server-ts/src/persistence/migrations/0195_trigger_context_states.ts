import { parseJsonText } from "@arden-hq/protocol/common"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const CAUSE_SOURCE = { count: "count", event: "event", coalesced: "coalesced" } as const
type CauseSource = (typeof CAUSE_SOURCE)[keyof typeof CAUSE_SOURCE]
const isCauseSource = (value: unknown): value is CauseSource =>
  Object.values<unknown>(CAUSE_SOURCE).includes(value)
const IMMUTABLE_RUN = "automation_runs_immutable_context"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const countCause = (cause: Json): Json => {
  if (Object.hasOwn(cause, "through")) return cause
  const { through_sequence: sequence, ...rest } = cause
  return {
    ...rest,
    through: typeof sequence === "number" ? { kind: "message", sequence } : { kind: "unrecorded" }
  }
}

const producerOf = (producer: unknown): unknown => {
  if (isObject(producer)) return producer
  return typeof producer === "string"
    ? { kind: "automation", automation_id: producer }
    : { kind: "outside" }
}

const eventCause = (cause: Json): Json => {
  const depth = cause["chain_depth"]
  return {
    ...cause,
    produced_by: producerOf(cause["produced_by"]),
    chain_depth: typeof depth === "number" ? depth : 0
  }
}

const directCause = (cause: unknown): unknown => {
  if (!isObject(cause)) return cause
  const source = cause["source"]
  if (!isCauseSource(source)) return cause
  switch (source) {
    case CAUSE_SOURCE.count:
      return countCause(cause)
    case CAUSE_SOURCE.event:
      return eventCause(cause)
    case CAUSE_SOURCE.coalesced:
      return cause
  }
}

export const todayTriggerContext = (context: unknown): unknown => {
  if (!isObject(context) || context["source"] !== CAUSE_SOURCE.coalesced)
    return directCause(context)
  const causes = context["causes"]
  return { ...context, causes: Array.isArray(causes) ? causes.map(directCause) : causes }
}

const rewriteRuns = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      "SELECT id, trigger_json FROM automation_runs WHERE trigger_json IS NOT NULL AND json_valid(trigger_json)"
    )
    .all()
  const update = database.prepare("UPDATE automation_runs SET trigger_json = ? WHERE id = ?")
  for (const row of rows) {
    const text = row["trigger_json"]
    if (typeof text !== "string") continue
    const next = JSON.stringify(todayTriggerContext(parseJsonText(text)))
    if (next !== JSON.stringify(parseJsonText(text))) update.run(next, row["id"] ?? null)
  }
}

const rewriteQueue = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      `SELECT id, context FROM automation_event_queue
        WHERE json_valid(context) AND json_type(context, '$.trigger_context_snapshot') = 'object'`
    )
    .all()
  const update = database.prepare("UPDATE automation_event_queue SET context = ? WHERE id = ?")
  for (const row of rows) {
    const text = row["context"]
    if (typeof text !== "string") continue
    const context = parseJsonText(text)
    if (!isObject(context)) continue
    const snapshot = context["trigger_context_snapshot"]
    const next = todayTriggerContext(snapshot)
    if (JSON.stringify(next) !== JSON.stringify(snapshot))
      update.run(JSON.stringify({ ...context, trigger_context_snapshot: next }), row["id"] ?? null)
  }
}

const up = (database: DatabaseSync): void => {
  const trigger = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(IMMUTABLE_RUN)?.["sql"]
  if (typeof trigger === "string") database.exec(`DROP TRIGGER ${IMMUTABLE_RUN}`)
  rewriteRuns(database)
  if (typeof trigger === "string") database.exec(trigger)
  rewriteQueue(database)
}

export const triggerContextStates: Migration = {
  version: 195,
  name: "trigger_context_states",
  foreignKeys: { kind: "enforced" },
  up
}
