import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

const BEFORE_LIVENESS = 153

// An orphan is closed at the last time it is known to have been alive, not at
// the update: the Automation's cooldown counts from its last ending, and the
// history sorts by it.
it("closes job runs that no queue row names, and only those, at their last known activity", () => {
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
    const chatActive = "2026-10-09T12:41:07.000Z"
    database
      .prepare(`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
          assistant_message_id)
        VALUES ('chat-run', 'chat', 'running', ?, ?, 'assistant')`)
      .run(at, chatActive)
    const run = database.prepare(`INSERT INTO automation_runs
      (id, task_id, started_at, status, ended_at, chat_run_id) VALUES (?, ?, ?, ?, ?, ?)`)
    run.run(1, "job", at, "running", null, null)
    run.run(2, "job", at, "running", null, null)
    run.run(3, null, at, "running", null, null)
    run.run(4, "job", at, "completed", at, null)
    run.run(5, "job", at, "running", null, "chat-run")
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
      .prepare("SELECT id, status, outcome, error, ended_at FROM automation_runs ORDER BY id")
      .all()
    expect(rows).toEqual([
      {
        id: 1,
        status: "interrupted",
        outcome: "interrupted",
        error: "Its job ended before the run did",
        ended_at: at
      },
      { id: 2, status: "running", outcome: null, error: null, ended_at: null },
      { id: 3, status: "running", outcome: null, error: null, ended_at: null },
      { id: 4, status: "completed", outcome: null, error: null, ended_at: at },
      {
        id: 5,
        status: "interrupted",
        outcome: "interrupted",
        error: "Its job ended before the run did",
        ended_at: chatActive
      }
    ])
  } finally {
    database.close()
  }
})
