import { parseJsonText } from "@arden-hq/protocol/common"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const ROLES = new Set(["knowledge", "record", "contract"])
const SOURCE_KIND = { space: "space", recalled: "recalled" } as const

const withoutKeys = (value: Json, keys: ReadonlyArray<string>): Json =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

const todayMemorySource = (source: Json): Json => {
  const placed = source["reason"] === null ? withoutKeys(source, ["reason"]) : source
  if (source["kind"] === SOURCE_KIND.space) {
    if (isObject(source["page"])) return placed
    const pageId = text(source["page_id"])
    const version = text(source["version"])
    return {
      ...withoutKeys(placed, ["page_id", "version"]),
      page:
        pageId === undefined || version === undefined
          ? { kind: "none" }
          : { kind: "page", page_id: pageId, version }
    }
  }
  if (source["kind"] === SOURCE_KIND.recalled && !ROLES.has(text(source["role"]) ?? "")) {
    return { ...placed, role: "unrecorded" }
  }
  return placed
}

export const todayMemoryComposition = (composition: Json): Json => {
  if (isObject(composition["recall"])) return composition
  const revision = text(composition["revision"])
  const query = text(composition["query"])
  const budget = composition["budget"]
  const sources = Array.isArray(composition["sources"]) ? composition["sources"] : []
  return {
    ...withoutKeys(composition, ["query"]),
    revision: revision === undefined ? { kind: "unread" } : { kind: "read", revision },
    recall: query === undefined ? { kind: "none" } : { kind: "searched", query },
    budget: isObject(budget)
      ? { kind: "recorded", ...withoutKeys(budget, ["index"]) }
      : { kind: "unrecorded" },
    sources: sources.map((source) => (isObject(source) ? todayMemorySource(source) : source))
  }
}

const up = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      `SELECT run_id, context_manifest_json FROM run_sidecars
       WHERE context_manifest_json <> '[]' AND json_valid(context_manifest_json)`
    )
    .all()
  const update = database.prepare(
    "UPDATE run_sidecars SET context_manifest_json = ? WHERE run_id = ?"
  )
  for (const row of rows) {
    const stored = row["context_manifest_json"]
    if (typeof stored !== "string") continue
    const record = parseJsonText(stored)
    if (!Array.isArray(record)) continue
    const next = JSON.stringify(
      record.map((composition) =>
        isObject(composition) ? todayMemoryComposition(composition) : composition
      )
    )
    if (next !== stored) update.run(next, row["run_id"] ?? null)
  }
}

export const memoryContextStates: Migration = {
  version: 201,
  name: "memory_context_states",
  foreignKeys: { kind: "enforced" },
  up
}
