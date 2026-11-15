import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/**
 * Rewrites two stored records that carried retired values, once, so they are read as stored:
 * - A run's Memory record (`run_sidecars.context_manifest_json`): a composition without a
 *   reader was the owner's; `collection` sources are gone; a retired reason becomes the
 *   allowance of its kind, and a Space source dropped for a retired reason is gone.
 * - A Space review input that a server path reads (a running review's `automation_runs.input_json`,
 *   `space_review_checkpoints`, and a queued job's `space_review_input`): pages with the
 *   `resident` basis are gone, in `pages` and in `reads.pages`. A finished run's input stays as
 *   it was sent; only replays read it, through `todayReviewInput`.
 * A row already in today's shape is left as it is.
 */

const RETIRED_REASONS: ReadonlySet<unknown> = new Set([
  "block_budget",
  "core_page_budget",
  "continuity_budget"
])
const ALLOWANCE_OF: Readonly<Record<string, string>> = {
  core: "standing_page_allowance",
  index: "index_allowance",
  recalled: "recall_allowance"
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const todaySource = (source: unknown): ReadonlyArray<unknown> => {
  if (!isObject(source)) return [source]
  if (source["kind"] === "collection") return []
  if (!RETIRED_REASONS.has(source["reason"])) return [source]
  if (source["kind"] === "space") return []
  const allowance = ALLOWANCE_OF[String(source["kind"])]
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

const rewriteRecords = (database: DatabaseSync): void => {
  const update = database.prepare(
    "UPDATE run_sidecars SET context_manifest_json = ? WHERE run_id = ?"
  )
  const rows = database
    .prepare(
      "SELECT run_id, context_manifest_json FROM run_sidecars WHERE context_manifest_json <> '[]'"
    )
    .all()
  for (const row of rows) {
    const stored = JSON.parse(String(row["context_manifest_json"])) as unknown
    const next = JSON.stringify(todayRecord(stored))
    if (next !== JSON.stringify(stored)) update.run(next, String(row["run_id"]))
  }
}

const withoutResident = (pages: unknown): unknown =>
  Array.isArray(pages)
    ? pages.filter((page) => !isObject(page) || page["basis"] !== "resident")
    : pages

export const todayReviewInput = (input: unknown): unknown => {
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

// Review inputs are large: SQLite picks the rows that name a resident page, and each is parsed once.
const RESIDENT = `'%"basis":"resident"%'`
const REVIEW_INPUTS = [
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

const dropResident = (database: DatabaseSync, input: (typeof REVIEW_INPUTS)[number]): void => {
  const { table, key, column } = input
  const keys = database
    .prepare(
      `SELECT ${key} AS key FROM ${table} WHERE ${input.where} AND ${column} LIKE ${RESIDENT}`
    )
    .all()
  const read = database.prepare(`SELECT ${column} AS stored FROM ${table} WHERE ${key} = ?`)
  const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`)
  for (const row of keys) {
    const id = row["key"] as string | number
    const stored = JSON.parse(String(read.get(id)?.["stored"])) as unknown
    update.run(JSON.stringify(input.today(stored)), id)
  }
}

const IMMUTABLE_RUN = "automation_runs_immutable_context"

const up = (database: DatabaseSync): void => {
  rewriteRecords(database)
  const trigger = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(IMMUTABLE_RUN)?.["sql"]
  if (typeof trigger === "string") database.exec(`DROP TRIGGER ${IMMUTABLE_RUN}`)
  for (const input of REVIEW_INPUTS) dropResident(database, input)
  if (typeof trigger === "string") database.exec(trigger)
}

export const retiredMemoryRecords: Migration = {
  version: 167,
  name: "retired_memory_records",
  foreignKeys: { kind: "enforced" },
  up
}
