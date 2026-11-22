import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { taskJobId } from "../src/persistence/space-job-id.js"
import { backgroundUsage } from "../src/persistence/sqlite/usage-background.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { claim, makeTask } from "./work-fixtures.js"

it("a Task attempt's usage carries the Task's current name, not a kept old row's", async () => {
  const rows = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const work = yield* WorkStore
      const task = yield* makeTask
      const current = yield* work.get({ kind: "item", itemId: task.item_id })
      yield* work.update({ kind: "item", itemId: task.item_id }, current.updated_at, {
        text: "Renamed by the owner"
      })
      yield* sql`INSERT INTO scheduled_tasks (task_id, automation_ref, name, description, prompt, context_mode,
          triggers, enabled, created_at, auto_approve, builtin, tool_scope, triggers_source, purpose,
          owner_space_id, owner_task_id)
        VALUES (${taskJobId(task.item_id)}, 'internal-job~kept-task', 'KEPT_OLD_NAME',
          'Internal Space execution', 'Work.', 'fresh', '[]', 1, '2026-11-01T00:00:00.000Z', 1, 1,
          'all', 'space_runtime', 'task_execution', 'space-1', ${task.item_id})`
      const [lease] = yield* claim("first", 10)
      if (lease === undefined) throw new Error("The Task was not claimed")
      return yield* backgroundUsage(sql, "2000-01-01T00:00:00.000Z", "2200-01-01T00:00:00.000Z")
    })
  )
  expect(
    rows.map((row) => ({
      name: row.name,
      item_id: row.item_id,
      purpose: row.purpose,
      destination: row.destination,
      checks: row.checks
    }))
  ).toEqual([
    {
      name: "Renamed by the owner",
      item_id: "work:space-1:background",
      purpose: "task_execution",
      destination: { kind: "task", item_id: "work:space-1:background" },
      checks: 1
    }
  ])
})

it("an Automation's usage stays one row across a handler rename, under its current handler", async () => {
  const rows = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers,
          created_at, purpose, handler)
        VALUES ('builtin-urgent-events', 'events', 'Events', 'Check.', '[]',
          '2026-11-01T00:00:00.000Z', 'system', 'events')`
      yield* sql`INSERT INTO automation_runs (task_id, purpose, handler, started_at, ended_at, status)
        VALUES ('builtin-urgent-events', 'system', 'urgent_events', '2026-11-10T00:00:00.000Z',
          '2026-11-10T00:01:00.000Z', 'completed'),
        ('builtin-urgent-events', 'system', 'events', '2026-11-21T00:00:00.000Z',
          '2026-11-21T00:01:00.000Z', 'completed')`
      return yield* backgroundUsage(sql, "2000-01-01T00:00:00.000Z", "2200-01-01T00:00:00.000Z")
    })
  )
  expect(rows.map((row) => ({ name: row.name, handler: row.handler, checks: row.checks }))).toEqual(
    [{ name: "Events", handler: "events", checks: 2 }]
  )
})

it("usage of a deleted Automation keeps the handler its runs recorded", async () => {
  const rows = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO automation_runs (task_id, purpose, handler, started_at, ended_at, status)
        VALUES ('builtin-gone', 'system', 'urgent_events', '2026-11-10T00:00:00.000Z',
          '2026-11-10T00:01:00.000Z', 'completed')`
      return yield* backgroundUsage(sql, "2000-01-01T00:00:00.000Z", "2200-01-01T00:00:00.000Z")
    })
  )
  expect(rows.map((row) => ({ handler: row.handler, checks: row.checks }))).toEqual([
    { handler: "urgent_events", checks: 1 }
  ])
})
