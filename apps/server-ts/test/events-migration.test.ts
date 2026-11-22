import { expect, it } from "vitest"
import { migratedTo } from "./fixtures/migrated-to.js"

const AT = "2026-11-20T00:00:00.000Z"

it("184 moves the Urgent events job to the events handler, and its past runs keep theirs", () => {
  const database = migratedTo(184, (database) => {
    database.exec(`INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers,
        created_at, purpose, handler)
      VALUES ('builtin-urgent-events', 'urgent-events', 'Urgent events', 'Tell me.', '[]', '${AT}',
        'system', 'urgent_events')`)
    database.exec(`INSERT INTO automation_runs (task_id, handler, started_at, status)
      VALUES ('builtin-urgent-events', 'urgent_events', '${AT}', 'completed'),
        ('builtin-daily-summary', 'daily_summary', '${AT}', 'completed')`)
  })
  expect(database.prepare("SELECT handler FROM scheduled_tasks").all()).toEqual([
    { handler: "events" }
  ])
  expect(database.prepare("SELECT handler FROM automation_runs ORDER BY id").all()).toEqual([
    { handler: "urgent_events" },
    { handler: "daily_summary" }
  ])
  database.close()
})
