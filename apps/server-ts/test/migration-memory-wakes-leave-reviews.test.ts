import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { memoryWakesLeaveReviews } from "../src/persistence/migrations/0162_memory_wakes_leave_reviews.js"
import { migrations } from "../src/persistence/migrations/index.js"

const at = "2026-11-01T00:00:00.000Z"

const event = (event_type: string, event_key: string) => ({
  source: "event",
  queued_at: at,
  event_type,
  event_key,
  produced_by: null,
  context: {}
})
const memory = event("wiki.changed", "a".repeat(64))
const chat = event("chat.completed", "run-1")
const wake = { source: "wake", queued_at: at }
const coalesced = (...causes: ReadonlyArray<object>) => ({
  source: "coalesced",
  queued_at: at,
  causes
})
const context = (snapshot: object, extra: object = {}) =>
  JSON.stringify({
    scheduled_for: null,
    automation_run_id: null,
    trigger_context_snapshot: snapshot,
    ...extra
  })

it("migration 0162 drops the Memory wakes queued for Space reviews and keeps every other cause", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter(
    (entry) => entry.version < memoryWakesLeaveReviews.version
  ))
    migration.up(database)
  const job = database.prepare(`INSERT INTO scheduled_tasks (task_id, automation_ref, prompt,
      context_mode, triggers, created_at, purpose, owner_space_id, tool_scope)
    VALUES (?, ?, 'Made up.', 'fresh', '[]', '${at}', ?, ?, 'space')`)
  job.run("space:space-1", "ref-1", "space_review", "space-1")
  job.run("builtin-wiki-maintenance", "ref-2", "system", null)
  const row = database.prepare(`INSERT INTO automation_event_queue (id, task_id, source, event_key,
      context, created_at, claimed_at) VALUES (?, ?, ?, ?, ?, '${at}', ?)`)
  const review = "space:space-1"
  row.run(1, review, "event", "wiki.changed:a", context(memory, { triggering_change: "a" }), null)
  row.run(2, review, "wake", review, context(coalesced(wake, memory, chat)), null)
  row.run(3, review, "wake", review, context(coalesced(memory, memory)), null)
  row.run(4, review, "wake", review, context(coalesced(memory, chat)), null)
  row.run(5, review, "event", "chat.completed:run-1", context(chat), null)
  row.run(6, review, "event", "wiki.changed:b", context(memory), at)
  row.run(7, "builtin-wiki-maintenance", "event", "wiki.changed:a", context(memory), null)
  const before = database.prepare("SELECT * FROM automation_event_queue ORDER BY id").all()

  memoryWakesLeaveReviews.up(database)

  const after = database.prepare("SELECT * FROM automation_event_queue ORDER BY id").all()
  expect(after.map((entry) => entry["id"])).toEqual([2, 4, 5, 6, 7])
  const snapshot = (id: number) =>
    JSON.parse(String(after.find((entry) => entry["id"] === id)?.["context"]))
  expect(snapshot(2).trigger_context_snapshot).toEqual(coalesced(wake, chat))
  expect(snapshot(4).trigger_context_snapshot).toEqual(chat)
  // A row already claimed by a run, a row with no Memory cause, and another job's rows stay.
  for (const id of [5, 6, 7])
    expect(after.find((entry) => entry["id"] === id)).toEqual(
      before.find((entry) => entry["id"] === id)
    )
})
