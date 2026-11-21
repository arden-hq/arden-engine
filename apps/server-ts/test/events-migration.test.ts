import type { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { migratedTo } from "./fixtures/migrated-to.js"

const AT = "2026-11-20T00:00:00.000Z"

const urgentEvents = (database: DatabaseSync, state: { readonly autoResumeAt: string | null }) => {
  database
    .prepare(
      `INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers, created_at,
        purpose, handler, enabled, paused_at, auto_resume_at, auto_resumes, failed_runs)
      VALUES ('builtin-urgent-events', 'urgent-events', 'Urgent events', 'Tell me.', '[]', ?,
        'system', 'urgent_events', 0, ?, ?, 1, 2)`
    )
    .run(AT, AT, state.autoResumeAt)
  database
    .prepare(
      `INSERT INTO automation_deliveries (delivery_id, task_id, subject, body, payload, status,
        created_at, destinations)
      VALUES (?, 'builtin-urgent-events', 'Paused', 'Paused', ?, 'delivered', ?, '[]')`
    )
    .run("a".repeat(64), JSON.stringify({ kind: "automation_paused", resumedAt: null }), AT)
}

const stateOf = (database: DatabaseSync) => ({
  row: database
    .prepare(
      `SELECT enabled, paused_at, auto_resume_at, auto_resumes, failed_runs FROM scheduled_tasks
      WHERE task_id = 'builtin-urgent-events'`
    )
    .get(),
  resumed: database
    .prepare(
      `SELECT json_extract(payload, '$.resumedAt') IS NOT NULL AS resumed
      FROM automation_deliveries WHERE task_id = 'builtin-urgent-events'`
    )
    .get()
})

it("M1b re-enables an Urgent events row that paused itself and waits to resume", () => {
  const database = migratedTo(184, (database) => urgentEvents(database, { autoResumeAt: AT }))
  expect(stateOf(database)).toEqual({
    row: { enabled: 1, paused_at: null, auto_resume_at: null, auto_resumes: 0, failed_runs: 0 },
    resumed: { resumed: 1 }
  })
  database.close()
})

it("M1b leaves an Urgent events row the owner turned off as it is", () => {
  const database = migratedTo(184, (database) => urgentEvents(database, { autoResumeAt: null }))
  expect(stateOf(database)).toEqual({
    row: { enabled: 0, paused_at: AT, auto_resume_at: null, auto_resumes: 1, failed_runs: 2 },
    resumed: { resumed: 0 }
  })
  database.close()
})
