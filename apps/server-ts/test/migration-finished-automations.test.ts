import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { finishedAutomations } from "../src/persistence/migrations/0101_finished_automations.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

it("removes self-stopped and spent one-time Automations, and keeps paused ones", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec("PRAGMA user_version = 1")
    for (const step of pendingMigrationSteps(
      { kind: "pending", from: 1, bridge: undefined },
      migrations.filter((entry) => entry.version < finishedAutomations.version)
    ))
      step.run(database)
    database.exec("PRAGMA foreign_keys = ON")
    const at = "2026-10-01T00:00:00.000Z"
    const automation = database.prepare(`INSERT INTO scheduled_tasks
      (task_id, automation_ref, name, prompt, triggers, enabled, created_at, thread_id,
        context_mode, followup_generation)
      VALUES (?, ?, ?, 'Check', ?, ?, ?, ?, 'fresh', ?)`)
    const chat = database.prepare(`INSERT INTO sessions
      (session_id, public_ref, started_at, last_activity, session_type, origin_automation_id)
      VALUES (?, ?, ?, ?, 'channel', ?)`)
    const run = database.prepare(`INSERT INTO automation_runs
      (task_id, started_at, ended_at, status, trigger_json, followup_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
    const every = JSON.stringify([{ id: "t1", type: "time", every: "30m" }])
    const once = JSON.stringify([{ id: "t1", type: "time", at: "12:00", on: "2026-10-05" }])
    const scheduled = JSON.stringify({ source: "scheduled" })
    const stop = (generation: number) =>
      JSON.stringify({ run_id: "r", action: "stop", at: null, generation })
    const cases = [
      { id: "stopped", triggers: every, generation: 1, status: "completed", followup: stop(1) },
      { id: "spent", triggers: once, generation: 0, status: "completed", followup: null },
      { id: "paused", triggers: every, generation: 2, status: "completed", followup: stop(1) },
      { id: "failed", triggers: once, generation: 0, status: "failed", followup: null },
      { id: "early", triggers: once, generation: 0, status: undefined, followup: null }
    ]
    for (const entry of cases) {
      automation.run(
        entry.id,
        `ref-${entry.id}`,
        entry.id,
        entry.triggers,
        0,
        at,
        `chat-${entry.id}`,
        entry.generation
      )
      chat.run(`chat-${entry.id}`, `public-${entry.id}`, at, at, entry.id)
      if (entry.status !== undefined)
        run.run(entry.id, at, at, entry.status, scheduled, entry.followup)
    }
    for (const step of pendingMigrationSteps({
      kind: "pending",
      from: finishedAutomations.version - 1,
      bridge: undefined
    }))
      step.run(database)
    expect(database.prepare("SELECT task_id FROM scheduled_tasks ORDER BY task_id").all()).toEqual([
      { task_id: "early" },
      { task_id: "failed" },
      { task_id: "paused" }
    ])
    expect(
      database
        .prepare(
          "SELECT origin_automation_id AS id FROM sessions WHERE archived_at IS NOT NULL ORDER BY id"
        )
        .all()
    ).toEqual([{ id: "spent" }, { id: "stopped" }])
    expect(database.prepare("SELECT COUNT(*) AS runs FROM automation_runs").get()).toEqual({
      runs: 4
    })
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    database.close()
  }
})
