import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// Maintenance runs from Memory changes, not from a clock.

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
      // The row as a database from before the update holds it: a 6-hour timer, due later.
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
