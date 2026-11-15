import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { reportRetentionRetired } from "../src/persistence/migrations/0167_report_retention_retired.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

it("removes the seeded Report Retention Automation and its jobs, and archives its chat", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec("PRAGMA user_version = 1")
    for (const step of pendingMigrationSteps(
      { kind: "pending", from: 1, bridge: undefined },
      migrations.filter((entry) => entry.version < reportRetentionRetired.version)
    ))
      step.run(database)
    database.exec("PRAGMA foreign_keys = ON")
    const at = "2026-11-14T00:00:00.000Z"
    const automation = database.prepare(`INSERT INTO scheduled_tasks
      (task_id, automation_ref, name, prompt, triggers, enabled, created_at, thread_id,
        context_mode, handler, builtin, purpose)
      VALUES (?, ?, ?, 'Run', '[]', 1, ?, ?, 'fresh', ?, 1, 'system')`)
    const chat = database.prepare(`INSERT INTO sessions
      (session_id, public_ref, started_at, last_activity, session_type, origin_automation_id)
      VALUES (?, ?, ?, ?, 'channel', ?)`)
    const job = database.prepare(`INSERT INTO automation_event_queue
      (task_id, source, event_key, context, created_at) VALUES (?, 'scheduled', ?, ?, ?)`)
    const reports = JSON.stringify({ handler_item: { input: { data: { kind: "reports" } } } })
    for (const [id, handler] of [
      ["builtin-report-retention", "report_retention"],
      ["builtin-wiki-maintenance", "wiki_maintenance"]
    ] as const) {
      automation.run(id, `ref-${id}`, id, at, `chat-${id}`, handler)
      chat.run(`chat-${id}`, `public-${id}`, at, at, id)
      job.run(id, `key-${id}`, id === "builtin-report-retention" ? reports : "{}", at)
    }
    database
      .prepare(
        "INSERT INTO automation_event_dedupe (task_id, event_key, seen_at) VALUES (?, 'seen', ?)"
      )
      .run("builtin-report-retention", at)

    for (const step of pendingMigrationSteps({
      kind: "pending",
      from: reportRetentionRetired.version - 1,
      bridge: undefined
    }))
      step.run(database)

    const ids = (sql: string) =>
      database
        .prepare(sql)
        .all()
        .map((row) => row["id"])
    expect({
      automations: ids("SELECT task_id AS id FROM scheduled_tasks ORDER BY id"),
      jobs: ids("SELECT task_id AS id FROM automation_event_queue ORDER BY id"),
      seen: ids("SELECT task_id AS id FROM automation_event_dedupe"),
      archived: ids(
        "SELECT origin_automation_id AS id FROM sessions WHERE archived_at IS NOT NULL ORDER BY id"
      ),
      foreignKeys: database.prepare("PRAGMA foreign_key_check").all()
    }).toEqual({
      automations: ["builtin-wiki-maintenance"],
      jobs: ["builtin-wiki-maintenance"],
      seen: [],
      archived: ["builtin-report-retention"],
      foreignKeys: []
    })
  } finally {
    database.close()
  }
})
