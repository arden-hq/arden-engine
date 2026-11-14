import { DatabaseSync } from "node:sqlite"
import { Option, Schema } from "effect"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"
import { QueueContextSchema } from "../src/persistence/sqlite/automation-queue-context.js"

// A Capture job prepared before the update holds a batch in the old shape, which the new batch
// schema cannot read. The update deletes that job, so every claim can still read the queue, and
// the job's run closes as interrupted. Other jobs keep their rows.

const BEFORE_POSITIONS = 154
const AT = "2026-11-14T10:00:00.000Z"

const item = (data: unknown) => ({
  id: "item-1",
  attempt: 1,
  previousRunId: null,
  reviewed: 0,
  skipped: 0,
  phase: "pending",
  runId: "chat-run-1",
  input: { sessionId: "job-chat", name: "Job", instructions: "Read the batch.", data }
})

const oldCaptureBatch = {
  kind: "memory",
  batch: {
    identity: {
      sessionId: "owner",
      contextGeneration: 0,
      start: { _tag: "Beginning" },
      end: { sequence: 1, offset: 0 }
    },
    markdown: "batch",
    jobs: [{ runId: "owner-run", sessionId: "owner", contextGeneration: 0, throughSequence: 1 }],
    final: true
  }
}

const dailyItem = {
  kind: "daily",
  date: "2026-11-13",
  timezone: "UTC",
  markdown: "day"
}

it("deletes Capture jobs prepared in the old batch shape and closes their runs", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec("PRAGMA user_version = 1")
    for (const step of pendingMigrationSteps(
      { kind: "pending", from: 1, bridge: undefined },
      migrations.filter((entry) => entry.version <= BEFORE_POSITIONS)
    ))
      step.run(database)
    database.exec("PRAGMA foreign_keys = ON")
    const run = database.prepare(`INSERT INTO automation_runs (id, task_id, started_at, status)
      VALUES (?, ?, ?, 'running')`)
    run.run(1, "capture", AT)
    run.run(2, "daily", AT)
    run.run(3, "capture", AT)
    const queue =
      database.prepare(`INSERT INTO automation_event_queue (task_id, source, event_key, context, created_at)
      VALUES (?, 'manual', ?, ?, ?)`)
    queue.run(
      "capture",
      "prepared",
      JSON.stringify({
        scheduled_for: null,
        automation_run_id: 1,
        handler_item: item(oldCaptureBatch)
      }),
      AT
    )
    queue.run(
      "daily",
      "daily",
      JSON.stringify({ scheduled_for: null, automation_run_id: 2, handler_item: item(dailyItem) }),
      AT
    )
    queue.run(
      "capture",
      "claimed",
      JSON.stringify({ scheduled_for: null, automation_run_id: 3 }),
      AT
    )
    queue.run(
      "capture",
      "fresh",
      JSON.stringify({ scheduled_for: null, automation_run_id: null }),
      AT
    )

    for (const step of pendingMigrationSteps({
      kind: "pending",
      from: BEFORE_POSITIONS,
      bridge: undefined
    }))
      step.run(database)

    const rows = database
      .prepare("SELECT event_key, context FROM automation_event_queue ORDER BY event_key")
      .all() as ReadonlyArray<{ readonly event_key: string; readonly context: string }>
    const decode = Schema.decodeUnknownOption(Schema.fromJsonString(QueueContextSchema))
    expect(
      rows.filter((row) => Option.isNone(decode(row.context))).map((row) => row.event_key)
    ).toEqual([])
    expect(rows.map((row) => row.event_key)).toEqual(["claimed", "daily", "fresh"])
    expect(
      database.prepare("SELECT id, status, outcome FROM automation_runs ORDER BY id").all()
    ).toEqual([
      { id: 1, status: "interrupted", outcome: "interrupted" },
      { id: 2, status: "running", outcome: null },
      { id: 3, status: "running", outcome: null }
    ])
  } finally {
    database.close()
  }
})
