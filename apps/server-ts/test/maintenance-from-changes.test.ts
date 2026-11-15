import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const MAINTENANCE = wikiMaintenanceHandler.spec.automationId

it("Maintenance has no time trigger, only its change trigger", () => {
  expect(wikiMaintenanceHandler.spec.triggers).toEqual([
    { type: "event", event_type: "wiki.changed" }
  ])
})

it("a stored timer is gone after the system Automations are seeded again", async () => {
  const stored = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      yield* sql`UPDATE scheduled_tasks
        SET triggers = '[{"id":"t1","type":"time","every":"6h"},{"id":"t2","type":"event","event_type":"wiki.changed"}]',
          next_run_at = '2099-01-01T00:00:00.000Z'
        WHERE task_id = ${MAINTENANCE}`
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      const rows = yield* sql<{ readonly triggers: string; readonly next_run_at: string | null }>`
        SELECT triggers, next_run_at FROM scheduled_tasks WHERE task_id = ${MAINTENANCE}`
      return rows.map((row) => ({
        types: (JSON.parse(row.triggers) as ReadonlyArray<{ readonly type: string }>).map(
          (trigger) => trigger.type
        ),
        nextRunAt: row.next_run_at
      }))
    })
  )
  expect(stored).toEqual([{ types: ["event"], nextRunAt: null }])
})

it("Maintenance is shown as Tidy under its old id, and a reseed renames a stored job and its chat", async () => {
  const stored = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      yield* sql`UPDATE scheduled_tasks SET name = 'Wiki Maintenance' WHERE task_id = ${MAINTENANCE}`
      yield* sql`UPDATE sessions SET name = 'Wiki Maintenance'
        WHERE session_id = (SELECT thread_id FROM scheduled_tasks WHERE task_id = ${MAINTENANCE})`
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      return yield* sql<{ readonly job: string; readonly chat: string | null }>`
        SELECT task.name AS job, chat.name AS chat FROM scheduled_tasks AS task
        LEFT JOIN sessions AS chat ON chat.session_id = task.thread_id
        WHERE task.task_id = ${MAINTENANCE}`
    })
  )
  expect(MAINTENANCE).toBe("builtin-wiki-maintenance")
  expect(stored).toEqual([{ job: "Tidy", chat: "Tidy" }])
})

it("a reseed keeps a name the owner gave a system job's chat, and renames the job", async () => {
  const stored = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      yield* sql`UPDATE scheduled_tasks SET name = 'Wiki Maintenance' WHERE task_id = ${MAINTENANCE}`
      yield* sql`UPDATE sessions SET name = 'My upkeep'
        WHERE session_id = (SELECT thread_id FROM scheduled_tasks WHERE task_id = ${MAINTENANCE})`
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      return yield* sql<{ readonly job: string; readonly chat: string | null }>`
        SELECT task.name AS job, chat.name AS chat FROM scheduled_tasks AS task
        LEFT JOIN sessions AS chat ON chat.session_id = task.thread_id
        WHERE task.task_id = ${MAINTENANCE}`
    })
  )
  expect(stored).toEqual([{ job: "Tidy", chat: "My upkeep" }])
})

it("names the job Tidy everywhere a run or the owner reads it", () => {
  const root = join(import.meta.dirname, "../src")
  const sources = (directory: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sources(path)
      return /\.(?:ts|md)$/u.test(entry.name) ? [path] : []
    })
  const naming = sources(root)
    .filter((path) => /Wiki Maintenance/u.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))
  expect(naming).toEqual([])
})
