import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { WikiChangeSink } from "../src/wiki/publication.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

it("Tidy wakes at any chain depth; an owner Automation on wiki.changed stops at the limit", async () => {
  const queued = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      const listener = yield* catalog.create(
        {
          name: "Made-up listener",
          prompt: "Read the Memory change",
          history: "fresh",
          triggers: [{ type: "event", event_type: "wiki.changed" }],
          idempotency_key: "7d9e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a",
          idempotency_scope: "global"
        },
        "owner"
      )
      const sink = yield* WikiChangeSink
      yield* sink.cursor(null)
      const woken = (previousRevision: string | null, revision: string, chainDepth: number) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM automation_event_queue`
          yield* sink.publish({
            previousRevision,
            revision,
            savedAt: "2026-11-01T00:00:00.000Z",
            paths: ["notes/made-up.md"],
            origin: {
              kind: "automation",
              automationId: "made-up-other",
              chainDepth
            },
            hasSpacePage: false
          })
          const rows = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM automation_event_queue`
          const tasks = rows.map((row) => row.task_id)
          return [
            ...(tasks.includes(listener.task_id) ? ["listener"] : []),
            ...(tasks.includes(wikiMaintenanceHandler.spec.automationId) ? ["tidy"] : [])
          ]
        })
      return {
        shallow: yield* woken(null, "a".repeat(64), 0),
        deep: yield* woken("a".repeat(64), "b".repeat(64), 2)
      }
    }).pipe(Effect.provide(automationWikiChangeSinkLayer))
  )
  expect(queued).toEqual({ shallow: ["listener", "tidy"], deep: ["tidy"] })
})
