import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { urgentEventsHandler } from "../src/automations/handlers/urgent-events.js"
import { screenEventWake } from "../src/automations/prefilter.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { claimAll } from "./fixtures/job-runs.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

it("a screened event wake of an authored Automation records its skip under the claim", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queue = yield* AutomationQueue
      yield* (yield* AutomationCatalog).seedSystemAutomations([urgentEventsHandler.spec])
      yield* (yield* AutomationTriggers).publishSourceEvents({
        eventType: "email.received",
        source: "made-up",
        cursor: "item-1",
        events: [
          {
            eventType: "email.received",
            eventKey: "item-1",
            producedBy: null,
            chainDepth: 0,
            context: {
              item: {
                item_id: "item-1",
                title: "Made-up title",
                sender: "A <a@x.test>",
                received_at: "2026-11-18T09:00:00.000Z",
                snippet: "Made-up words"
              }
            }
          }
        ]
      })
      const [lease] = yield* claimAll("screen")
      if (lease === undefined) throw new Error("Urgent events was not claimed")
      const decide = () =>
        Effect.succeed({
          by: "decision_model" as const,
          value: false,
          backend: "test",
          probability: 0.9
        })
      const decisions = { decide } as unknown as Parameters<typeof screenEventWake>[0]
      const screen = yield* screenEventWake(decisions)(lease)
      if (screen === undefined) throw new Error("The wake was not screened")
      const recorded = yield* queue.recordEventScreen({
        lease,
        screen,
        now: lease.expiresAt - 1_000
      })
      const [queued] = yield* sql<{ readonly events: number; readonly text: string | null }>`
        SELECT json_array_length(context, '$.event_batch.events') AS events,
          json_extract(context, '$.trigger_context') AS text
        FROM automation_event_queue WHERE id = ${Number(lease.id)}`
      const attempt = yield* sql<{ readonly status: string }>`
        SELECT status FROM automation_runs WHERE id = ${lease.payload.automationRunId}`
      return {
        owner: lease.payload.automationId === urgentEventsHandler.spec.automationId,
        skippedKeys: screen.skipped.length,
        kind: recorded.kind,
        events: queued?.events,
        hasText: (queued?.text ?? "").includes("Made-up title"),
        attempt: attempt.map((row) => row.status)
      }
    })
  )
  expect(outcome).toEqual({
    owner: true,
    skippedKeys: 1,
    kind: "skip",
    events: 1,
    hasText: true,
    attempt: ["running"]
  })
})
