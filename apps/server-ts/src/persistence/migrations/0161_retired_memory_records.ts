import { parseMigrationJson } from "./json.js"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const RETIRED_REASONS: ReadonlySet<unknown> = new Set([
  "block_budget",
  "core_page_budget",
  "continuity_budget"
])
const COLLECTION_SOURCE = "collection"
const SPACE_SOURCE = "space"
const ALLOWANCE_OF: Readonly<Record<string, unknown>> = {
  core: "standing_page_allowance",
  index: "index_allowance",
  recalled: "recall_allowance"
}
const RESIDENT_BASIS = "resident"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const todaySource = (source: unknown): ReadonlyArray<unknown> => {
  if (!isObject(source)) return [source]
  const kind = source["kind"]
  if (kind === COLLECTION_SOURCE) return []
  if (!RETIRED_REASONS.has(source["reason"])) return [source]
  if (kind === SPACE_SOURCE) return []
  const allowance = ALLOWANCE_OF[String(kind)]
  return [allowance === undefined ? source : { ...source, reason: allowance }]
}

const todayComposition = (composition: unknown): unknown => {
  if (!isObject(composition)) return composition
  const sources = composition["sources"]
  return {
    reader: "owner",
    ...composition,
    sources: Array.isArray(sources) ? sources.flatMap(todaySource) : sources
  }
}

const todayRecord = (record: unknown): unknown =>
  Array.isArray(record) ? record.map(todayComposition) : record

const rewriteRunMemoryRecords = (database: DatabaseSync): void => {
  const update = database.prepare(
    "UPDATE run_sidecars SET context_manifest_json = ? WHERE run_id = ?"
  )
  const rows = database
    .prepare(
      "SELECT run_id, context_manifest_json FROM run_sidecars WHERE context_manifest_json <> '[]'"
    )
    .all()
  for (const row of rows) {
    const stored = parseMigrationJson(String(row["context_manifest_json"]))
    const next = JSON.stringify(todayRecord(stored))
    if (next !== JSON.stringify(stored)) update.run(next, String(row["run_id"]))
  }
}

const withoutResident = (pages: unknown): unknown =>
  Array.isArray(pages)
    ? pages.filter((page) => !isObject(page) || page["basis"] !== RESIDENT_BASIS)
    : pages

const todayReviewInput = (input: unknown): unknown => {
  if (!isObject(input)) return input
  const reads = input["reads"]
  return {
    ...input,
    pages: withoutResident(input["pages"]),
    ...(isObject(reads) ? { reads: { ...reads, pages: withoutResident(reads["pages"]) } } : {})
  }
}

const todayQueuedContext = (context: unknown): unknown =>
  isObject(context)
    ? { ...context, space_review_input: todayReviewInput(context["space_review_input"]) }
    : context

const RESIDENT_PAGE_LIKE = `'%"basis":"resident"%'`
const LIVE_REVIEW_INPUTS = [
  {
    table: "automation_runs",
    key: "id",
    column: "input_json",
    where: "status = 'running' AND purpose = 'space_review' AND input_json IS NOT NULL",
    today: todayReviewInput
  },
  {
    table: "space_review_checkpoints",
    key: "space_id",
    column: "reviewed_input",
    where: "1",
    today: todayReviewInput
  },
  {
    table: "automation_event_queue",
    key: "id",
    column: "context",
    where: "json_type(context, '$.space_review_input') = 'object'",
    today: todayQueuedContext
  }
] as const

const dropResident = (database: DatabaseSync, input: (typeof LIVE_REVIEW_INPUTS)[number]): void => {
  const { table, key, column } = input
  const keys = database
    .prepare(
      `SELECT ${key} AS key FROM ${table} WHERE ${input.where} AND ${column} LIKE ${RESIDENT_PAGE_LIKE}`
    )
    .all()
  const read = database.prepare(`SELECT ${column} AS stored FROM ${table} WHERE ${key} = ?`)
  const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`)
  for (const row of keys) {
    const id = row["key"] as string | number
    const stored = parseMigrationJson(String(read.get(id)?.["stored"]))
    update.run(JSON.stringify(input.today(stored)), id)
  }
}

const IMMUTABLE_RUN = "automation_runs_immutable_context"

const rewriteLiveReviewInputs = (database: DatabaseSync): void => {
  const trigger = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(IMMUTABLE_RUN)?.["sql"]
  if (typeof trigger === "string") database.exec(`DROP TRIGGER ${IMMUTABLE_RUN}`)
  for (const input of LIVE_REVIEW_INPUTS) dropResident(database, input)
  if (typeof trigger === "string") database.exec(trigger)
}

const up = (database: DatabaseSync): void => {
  rewriteRunMemoryRecords(database)
  rewriteLiveReviewInputs(database)
}

export const retiredMemoryRecords: Migration = {
  version: 161,
  name: "retired_memory_records",
  foreignKeys: { kind: "enforced" },
  up
}
