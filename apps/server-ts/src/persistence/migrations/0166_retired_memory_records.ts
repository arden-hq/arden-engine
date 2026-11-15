import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/**
 * Rewrites two stored records that carried retired values, once, so they are read as stored:
 * - A run's Memory record (`run_sidecars.context_manifest_json`): a composition without a
 *   reader was the owner's; `collection` sources are gone; a retired reason becomes the
 *   allowance of its kind, and a Space source dropped for a retired reason is gone.
 * - A Space review input (`automation_runs.input_json`, `space_review_checkpoints`, and a queued
 *   job's `space_review_input`): pages with the `resident` basis are gone, in `pages` and in
 *   `reads.pages`.
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

const withoutResident = (pages: unknown): unknown =>
  Array.isArray(pages)
    ? pages.filter((page) => !isObject(page) || page["basis"] !== "resident")
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
  isObject(context) && "space_review_input" in context
    ? { ...context, space_review_input: todayReviewInput(context["space_review_input"]) }
    : context

const rewrite = (
  database: DatabaseSync,
  query: { readonly select: string; readonly update: string },
  today: (stored: unknown) => unknown
): void => {
  const update = database.prepare(query.update)
  for (const row of database.prepare(query.select).all()) {
    const stored = String(row["stored"])
    const next = JSON.stringify(today(JSON.parse(stored)))
    if (next !== JSON.stringify(JSON.parse(stored))) update.run(next, row["id"] as string | number)
  }
}

const IMMUTABLE_RUN = "automation_runs_immutable_context"

const up = (database: DatabaseSync): void => {
  rewrite(
    database,
    {
      select: `SELECT run_id AS id, context_manifest_json AS stored FROM run_sidecars
        WHERE context_manifest_json <> '[]'`,
      update: "UPDATE run_sidecars SET context_manifest_json = ? WHERE run_id = ?"
    },
    todayRecord
  )
  const trigger = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(IMMUTABLE_RUN)?.["sql"]
  if (typeof trigger === "string") database.exec(`DROP TRIGGER ${IMMUTABLE_RUN}`)
  rewrite(
    database,
    {
      select: `SELECT id, input_json AS stored FROM automation_runs
        WHERE purpose = 'space_review' AND input_json IS NOT NULL`,
      update: "UPDATE automation_runs SET input_json = ? WHERE id = ?"
    },
    todayReviewInput
  )
  if (typeof trigger === "string") database.exec(trigger)
  rewrite(
    database,
    {
      select: "SELECT space_id AS id, reviewed_input AS stored FROM space_review_checkpoints",
      update: "UPDATE space_review_checkpoints SET reviewed_input = ? WHERE space_id = ?"
    },
    todayReviewInput
  )
  rewrite(
    database,
    {
      select: `SELECT id, context AS stored FROM automation_event_queue
        WHERE json_extract(context, '$.space_review_input') IS NOT NULL`,
      update: "UPDATE automation_event_queue SET context = ? WHERE id = ?"
    },
    todayQueuedContext
  )
}

export const retiredMemoryRecords: Migration = {
  version: 166,
  name: "retired_memory_records",
  foreignKeys: { kind: "enforced" },
  up
}
