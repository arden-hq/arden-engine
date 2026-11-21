import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { BASELINE_VERSION, migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

// Migration 180 on a schema-179 database that the old review rows describe. Every row
// is made up. The rows are written with SQL in the shape the 179 server wrote them
// (space-jobs.ts upsertJob and the claim), because no 179 server runs in this test.
const T0 = "2026-11-02T10:00:00.000Z"
const T1 = "2026-11-02T10:00:30.000Z"
const LATER = "2026-11-02T10:01:30.000Z"

const migrate = (database: DatabaseSync, from: number, through: number) => {
  const list = migrations.filter((migration) => migration.version <= through)
  for (const step of pendingMigrationSteps({ kind: "pending", from, bridge: undefined }, list))
    step.run(database)
  database.exec("PRAGMA foreign_keys = ON")
}

const seed179 = (database: DatabaseSync) => {
  const space =
    database.prepare(`INSERT INTO spaces (space_id, name, name_key, inference_policy, page_path, created_at, updated_at)
    VALUES (?, ?, ?, '{"enabled":true}', ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`)
  space.run("configured", "Configured", "configured", "projects/configured.md")
  space.run("plain", "Plain", "plain", "projects/plain.md")
  space.run("zero", "Zero", "zero", "projects/zero.md")
  const chat =
    database.prepare(`INSERT INTO sessions (session_id, public_ref, name, started_at, last_activity, session_type, origin_automation_id)
    VALUES (?, ?, ?, ?, ?, 'channel', ?)`)
  // Two channels for the configured review. The old row names the NEWER one.
  chat.run(
    "older-chat",
    "older-ref",
    "Configured worker",
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "space:configured"
  )
  chat.run(
    "pinned-chat",
    "pinned-ref",
    "Configured worker",
    "2026-11-01T01:00:00.000Z",
    "2026-11-01T01:00:00.000Z",
    "space:configured"
  )
  chat.run(
    "plain-chat",
    "plain-ref",
    "Plain worker",
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "space:plain"
  )
  const review =
    database.prepare(`INSERT INTO scheduled_tasks (task_id, automation_ref, name, description, prompt,
      model, context_mode, triggers, enabled, created_at, job_held_since, auto_approve, builtin, cooldown_minutes,
      thread_id, tool_scope, triggers_source, purpose, owner_space_id)
    VALUES (?, ?, ?, 'Internal Space execution', 'Review it.', ?, ?, '[]', 1, '2026-11-01T00:00:00.000Z', ?, 1, 1, ?,
      ?, 'space', 'space_runtime', 'space_review', ?)`)
  review.run(
    "space:configured",
    "internal-job~configured",
    "Configured worker",
    "review-model",
    "continue",
    T0,
    15,
    "pinned-chat",
    "configured"
  )
  review.run(
    "space:plain",
    "internal-job~plain",
    "Plain worker",
    null,
    "fresh",
    null,
    null,
    "plain-chat",
    "plain"
  )
  // A cooldown of zero is a valid stored setting (NonNegativeInt in the protocol).
  review.run("space:zero", "internal-job~zero", "Zero worker", null, "fresh", null, 0, null, "zero")
  // A review row whose Space is gone, and one whose chat is gone: nothing to carry.
  review.run(
    "space:gone",
    "internal-job~gone",
    "Gone worker",
    "gone-model",
    "fresh",
    null,
    5,
    "plain-chat",
    "gone"
  )
  // The configured review is held: a claimed row, its running attempt, the hold start T0 on the old row.
  const attempt = database
    .prepare(`INSERT INTO automation_runs (task_id, automation_ref, origin, purpose, context_mode,
      started_at, status, claim_count)
    VALUES ('space:configured', 'internal-job~configured', '{"kind":"space","space_id":"configured","occurrence_id":"q"}',
      'space_review', 'continue', ?, 'running', 2) RETURNING id`)
    .get(T0) as { id: number }
  const queued = database
    .prepare(`INSERT INTO automation_event_queue (task_id, source, event_key, context, created_at,
      claimed_at, lease_expires_at, attempt_count)
    VALUES ('space:configured', 'wake', 'space:configured', ?, ?, ?, ?, 2) RETURNING id`)
    .get(JSON.stringify({ scheduled_for: null, automation_run_id: attempt.id }), T0, T1, LATER) as {
    id: number
  }
  return { attemptId: attempt.id, queueId: queued.id }
}

it("migration 180 carries a review's settings, its exact chat and its hold start, and keeps the old rows", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec(`PRAGMA user_version = ${BASELINE_VERSION}`)
    migrate(database, BASELINE_VERSION, 179)
    const ids = seed179(database)
    const legacyBefore = database
      .prepare(`SELECT task_id, automation_ref, thread_id, model, cooldown_minutes, enabled
      FROM scheduled_tasks ORDER BY task_id`)
      .all()
    migrate(database, 179, 180)
    expect({
      version: database.prepare("PRAGMA user_version").get(),
      settings: database.prepare("SELECT * FROM space_review_settings ORDER BY space_id").all(),
      chats: database.prepare("SELECT * FROM space_review_chats ORDER BY space_id").all(),
      queue: database
        .prepare(
          "SELECT id, task_id, claimed_at, hold_started_at, context FROM automation_event_queue"
        )
        .all(),
      attempt: database
        .prepare("SELECT id, task_id, status, claim_count FROM automation_runs")
        .all(),
      legacyAfter: database
        .prepare(`SELECT task_id, automation_ref, thread_id, model, cooldown_minutes, enabled
        FROM scheduled_tasks ORDER BY task_id`)
        .all(),
      heldOnOldRows: database
        .prepare("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE job_held_since IS NOT NULL")
        .get()
    }).toEqual({
      version: { user_version: 180 },
      settings: [
        {
          space_id: "configured",
          model: "review-model",
          context_mode: "continue",
          cooldown_minutes: 15
        },
        { space_id: "zero", model: null, context_mode: "fresh", cooldown_minutes: 0 }
      ],
      chats: [
        { space_id: "configured", session_id: "pinned-chat" },
        { space_id: "plain", session_id: "plain-chat" }
      ],
      queue: [
        {
          id: ids.queueId,
          task_id: "space:configured",
          claimed_at: T1,
          hold_started_at: T0,
          context: JSON.stringify({ scheduled_for: null, automation_run_id: ids.attemptId })
        }
      ],
      attempt: [
        { id: ids.attemptId, task_id: "space:configured", status: "running", claim_count: 2 }
      ],
      legacyAfter: legacyBefore,
      heldOnOldRows: { n: 0 }
    })
  } finally {
    database.close()
  }
})
