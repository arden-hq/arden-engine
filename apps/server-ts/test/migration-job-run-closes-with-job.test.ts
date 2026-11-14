import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

const BEFORE_LIVENESS = 153

it("closes job runs that no queue row names, and only those", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec("PRAGMA user_version = 1")
    for (const step of pendingMigrationSteps(
      { kind: "pending", from: 1, bridge: undefined },
      migrations.filter((entry) => entry.version <= BEFORE_LIVENESS)
    ))
      step.run(database)
    database.exec("PRAGMA foreign_keys = ON")
    const at = "2026-10-09T12:30:00.000Z"
    const run =
      database.prepare(`INSERT INTO automation_runs (id, task_id, started_at, status, ended_at)
      VALUES (?, ?, ?, ?, ?)`)
    run.run(1, "job", at, "running", null)
    run.run(2, "job", at, "running", null)
    run.run(3, null, at, "running", null)
    run.run(4, "job", at, "completed", at)
    database
      .prepare(`INSERT INTO automation_event_queue (task_id, source, event_key, context, created_at)
        VALUES ('job', 'manual', 'kept', ?, ?)`)
      .run(JSON.stringify({ scheduled_for: null, automation_run_id: 2 }), at)
    for (const step of pendingMigrationSteps({
      kind: "pending",
      from: BEFORE_LIVENESS,
      bridge: undefined
    }))
      step.run(database)
    const rows = database
      .prepare(
        "SELECT id, status, outcome, error, ended_at IS NOT NULL AS ended FROM automation_runs ORDER BY id"
      )
      .all()
    expect(rows).toEqual([
      {
        id: 1,
        status: "interrupted",
        outcome: "interrupted",
        error: "Its job ended before the run did",
        ended: 1
      },
      { id: 2, status: "running", outcome: null, error: null, ended: 0 },
      { id: 3, status: "running", outcome: null, error: null, ended: 0 },
      { id: 4, status: "completed", outcome: null, error: null, ended: 1 }
    ])
  } finally {
    database.close()
  }
})
