import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { taskJobId } from "../src/persistence/space-job-id.js"
import { backgroundUsage } from "../src/persistence/sqlite/usage-background.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { claim, makeTask } from "./work-fixtures.js"

// A Task's background usage is named by the Task as it is now. An old definition row an
// earlier server kept under the Task's key is not its owner and does not name it.
// Real SQLite store, made-up rows.

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
      // The kept row's name is whatever it held when it stopped being the owner.
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
