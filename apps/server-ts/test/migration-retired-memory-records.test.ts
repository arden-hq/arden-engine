import { DatabaseSync } from "node:sqlite"
import { RunMemoryContextSchema } from "@arden-hq/protocol/effect/runs"
import { Schema } from "effect"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { retiredMemoryRecords } from "../src/persistence/migrations/0166_retired_memory_records.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { SpaceReviewInputSchema } from "../src/persistence/automations/space-review.js"

const at = "2026-11-01T00:00:00.000Z"

const migrated = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter(
    (entry) => entry.version < retiredMemoryRecords.version
  ))
    migration.up(database)
  return database
}

const placed = (outcome: "whole" | "cut" | "dropped", reason: string | null) => ({
  bytes: 9,
  outcome,
  reason
})

const oldRecord = [
  {
    revision: "rev-0",
    query: "an older question",
    sources: [
      { kind: "core", page_id: "me", version: "v", ...placed("cut", "core_page_budget") },
      { kind: "recalled", page_id: "a", version: "v", ...placed("cut", "recall_allowance") },
      { kind: "recalled", page_id: "b", version: "v", ...placed("dropped", "continuity_budget") },
      { kind: "collection", page_id: "c", version: "v", ...placed("whole", null) }
    ]
  },
  {
    reader: "worker",
    revision: "rev-0",
    query: null,
    sources: [
      { kind: "index", root: "", listed: 0, folded: [], ...placed("dropped", "block_budget") },
      {
        kind: "space",
        space_id: "s",
        page_id: null,
        version: null,
        ...placed("dropped", "block_budget")
      },
      {
        kind: "space",
        space_id: "s",
        page_id: null,
        version: null,
        ...placed("cut", "space_page_allowance")
      }
    ]
  }
]

const todayRecord = [
  {
    reader: "owner",
    revision: "rev-0",
    query: "an older question",
    sources: [
      { kind: "core", page_id: "me", version: "v", ...placed("cut", "standing_page_allowance") },
      { kind: "recalled", page_id: "a", version: "v", ...placed("cut", "recall_allowance") },
      { kind: "recalled", page_id: "b", version: "v", ...placed("dropped", "recall_allowance") }
    ]
  },
  {
    reader: "worker",
    revision: "rev-0",
    query: null,
    sources: [
      {
        kind: "index",
        root: "",
        listed: 0,
        folded: [],
        ...placed("dropped", "index_allowance")
      },
      {
        kind: "space",
        space_id: "s",
        page_id: null,
        version: null,
        ...placed("cut", "space_page_allowance")
      }
    ]
  }
]

const reviewPage = (pageId: string, basis: string) => ({
  pageId,
  path: `${pageId}.md`,
  version: "v2",
  basis
})

const reviewInput = (bases: ReadonlyArray<string>) => ({
  admission: "changed",
  spaceId: "space-1",
  repositoryHead: null,
  pages: bases.map((basis, index) => ({ ...reviewPage(`p${index}`, basis), rootPageId: "root" })),
  chats: [],
  semantic: "{}",
  unresolved: [],
  reads: {
    space: { name: "Made up", instructions: null },
    openTasks: [],
    proposals: [],
    memory: { base: null, head: null },
    pages: bases.map((basis, index) => ({
      ...reviewPage(`p${index}`, basis),
      previousVersion: null
    })),
    chats: [],
    removed: [],
    items: []
  },
  prompt: "Made-up prompt"
})

it("migration 0166 rewrites stored Memory records and the review inputs a server path reads", () => {
  const database = migrated()
  const sidecar = database.prepare(`INSERT INTO run_sidecars
    (run_id, session_id, context_manifest_json, source_refs_json, evidence_json, updated_at)
    VALUES (?, 's', ?, '[]', '{}', '${at}')`)
  sidecar.run("old", JSON.stringify(oldRecord))
  sidecar.run("today", JSON.stringify(todayRecord))
  sidecar.run("none", "[]")
  const run =
    database.prepare(`INSERT INTO automation_runs (task_id, purpose, started_at, input_json)
    VALUES ('job', ?, '${at}', ?)`)
  const stored = reviewInput(["resident", "owned", "linked", "resident", "source"])
  run.run("space_review", JSON.stringify(stored))
  run.run("space_review", JSON.stringify(reviewInput(["owned"])))
  run.run("system", JSON.stringify(stored))
  database
    .prepare(`INSERT INTO automation_runs (task_id, purpose, started_at, ended_at, status, input_json)
      VALUES ('job', 'space_review', '${at}', '${at}', 'completed', ?)`)
    .run(JSON.stringify(stored))
  database
    .prepare(`INSERT INTO space_review_checkpoints (space_id, reviewed_input, reviewed_at)
      VALUES ('space-1', ?, '${at}')`)
    .run(JSON.stringify(stored))
  database
    .prepare(`INSERT INTO automation_event_queue (task_id, source, event_key, context, created_at)
      VALUES ('job', 'event', 'key', ?, '${at}')`)
    .run(JSON.stringify({ space_review_input: stored, automation_run_id: 1 }))

  retiredMemoryRecords.up(database)

  const column = (sql: string) =>
    database
      .prepare(sql)
      .all()
      .map((row) => String(Object.values(row)[0]))
  const decodeRecord = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Array(RunMemoryContextSchema))
  )
  const records = column("SELECT context_manifest_json FROM run_sidecars ORDER BY run_id")
  expect(records.map((record) => decodeRecord(record))).toEqual([[], todayRecord, todayRecord])
  expect(records[2]).toBe(JSON.stringify(todayRecord))

  const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(SpaceReviewInputSchema))
  const bases = (json: string) => {
    const input = decodeInput(json)
    return [input.pages.map((page) => page.basis), input.reads?.pages.map((page) => page.basis)]
  }
  const kept = [
    ["owned", "linked", "source"],
    ["owned", "linked", "source"]
  ]
  expect(
    column(`SELECT input_json FROM automation_runs
      WHERE purpose = 'space_review' AND status = 'running' ORDER BY id`).map(bases)
  ).toEqual([kept, [["owned"], ["owned"]]])
  expect(column("SELECT input_json FROM automation_runs WHERE status = 'completed'")).toEqual([
    JSON.stringify(stored)
  ])
  expect(column("SELECT input_json FROM automation_runs WHERE purpose = 'system'")).toEqual([
    JSON.stringify(stored)
  ])
  expect(column("SELECT reviewed_input FROM space_review_checkpoints").map(bases)).toEqual([kept])
  const queued = column("SELECT context FROM automation_event_queue").map(
    (context) => JSON.parse(context) as { readonly space_review_input: unknown }
  )
  expect(queued.map((context) => bases(JSON.stringify(context.space_review_input)))).toEqual([kept])

  expect(
    column(`SELECT count(*) FROM automation_runs
        WHERE purpose = 'space_review' AND status = 'running' AND input_json LIKE '%"resident"%'
      UNION ALL SELECT count(*) FROM space_review_checkpoints WHERE reviewed_input LIKE '%"resident"%'
      UNION ALL SELECT count(*) FROM automation_event_queue WHERE context LIKE '%"resident"%'`)
  ).toEqual(["0", "0", "0"])

  expect(() =>
    database.exec("UPDATE automation_runs SET input_json = '{}' WHERE purpose = 'space_review'")
  ).toThrow(/immutable/u)
})
