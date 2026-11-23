import { createToolset } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { dailySummaryHandler } from "../src/automations/handlers/daily-summary.js"
import { eventsHandler } from "../src/automations/handlers/events.js"
import { connectionItemEvent } from "../src/automations/producers/connection-item.js"
import { SENT_BY_OWNER } from "../src/connections/items/gmail.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { claimAll, startJob } from "./fixtures/job-runs.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const SENTENCE = "It is from my bank."

it("Events keeps a Run only if sentence the owner rewrote and resets it; no other built-in takes one", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      yield* catalog.seedSystemAutomations([eventsHandler.spec, dailySummaryHandler.spec])
      const events = eventsHandler.spec.automationId
      const rewritten = yield* catalog.update(
        events,
        { triggers: [{ type: "event", event_type: "email.received", run_only_if: SENTENCE }] },
        "owner"
      )
      expect(rewritten?.triggers).toMatchObject([
        { event_type: "email.received", run_only_if: SENTENCE }
      ])
      expect(rewritten?.system?.changed).toContain("triggers")
      const reset = yield* catalog.resetSystemSetting(events, "triggers")
      expect(reset?.triggers).toMatchObject(eventsHandler.spec.triggers)
      yield* catalog
        .update(
          dailySummaryHandler.spec.automationId,
          { triggers: [{ type: "event", event_type: "email.received", run_only_if: SENTENCE }] },
          "owner"
        )
        .pipe(Effect.flip)
    })
  )
})

it("Events takes only item triggers: an owner's other trigger is refused, and an old one is dropped at seeding", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const events = eventsHandler.spec.automationId
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      const mail = {
        type: "event" as const,
        event_type: "email.received" as const,
        run_only_if: SENTENCE
      }
      yield* catalog
        .update(
          events,
          {
            triggers: [mail, { type: "event", event_type: "task.changed", run_only_if: SENTENCE }]
          },
          "owner"
        )
        .pipe(Effect.flip)
      yield* catalog.update(events, { triggers: [mail] }, "owner")
      yield* sql`UPDATE scheduled_tasks SET triggers = json_insert(triggers, '$[#]',
          json_object('id', 't99', 'type', 'time', 'at', '08:00', 'days', 'daily')),
          next_run_at = '2026-11-23T08:00:00.000Z'
        WHERE task_id = ${events}`
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      const seeded = yield* catalog.get(events)
      expect(seeded?.triggers).toMatchObject([mail])
      expect(seeded?.triggers).toHaveLength(1)
      expect(
        yield* sql`SELECT triggers_source, next_run_at FROM scheduled_tasks WHERE task_id = ${events}`
      ).toEqual([{ triggers_source: "manual", next_run_at: null }])
    })
  )
})

it("seeding resumes Events only from a booked retry; any other pause stays off", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const events = eventsHandler.spec.automationId
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      const state = sql<{
        readonly enabled: number
        readonly paused_at: string | null
        readonly failed_runs: number
        readonly resumed: number
      }>`SELECT task.enabled, task.paused_at, task.failed_runs,
          (SELECT COUNT(*) FROM automation_deliveries AS pause
            WHERE pause.task_id = task.task_id
              AND json_extract(pause.payload, '$.resumedAt') IS NOT NULL) AS resumed
        FROM scheduled_tasks AS task WHERE task.task_id = ${events}`
      const pauseAt = "2026-11-18T09:00:00.000Z"
      const pause = (retryAt: string | null, attemptId: number) =>
        Effect.gen(function* () {
          yield* sql`UPDATE scheduled_tasks SET enabled = 0, paused_at = ${pauseAt},
              auto_resume_at = ${retryAt}, failed_runs = 3
            WHERE task_id = ${events}`
          yield* sql`INSERT INTO automation_deliveries (delivery_id, task_id, delivered_at, subject,
              body, payload, status, created_at, destinations)
            VALUES (${String(attemptId).repeat(64)}, ${events}, ${pauseAt}, 'Paused', 'Paused',
              ${JSON.stringify({ kind: "automation_paused", attemptId, resumedAt: null })},
              'delivered', ${pauseAt}, '[]')`
        })
      yield* pause("2026-11-18T10:00:00.000Z", 1)
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      expect(yield* state).toEqual([{ enabled: 1, paused_at: null, failed_runs: 0, resumed: 1 }])
      yield* pause(null, 2)
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      expect(yield* state).toEqual([{ enabled: 0, paused_at: pauseAt, failed_runs: 3, resumed: 1 }])
      yield* pause("2026-11-18T10:00:00.000Z", 3)
      yield* catalog.update(events, { enabled: false }, "owner")
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      expect(yield* state).toMatchObject([{ enabled: 0 }])
    })
  )
})

it("an Events run reads with the read-only scope and adds only post_message", async () => {
  const added = await (eventsHandler.tools ?? ((base) => base))(
    createToolset([], {
      toJsonSchema: (schema: Schema.Constraint) => Schema.toJsonSchemaDocument(schema).schema
    })(undefined)
  ).entries()
  expect(added.map((entry) => entry.meta.name)).toEqual(["post_message"])
  expect(eventsHandler.extraCapabilities).toBeUndefined()
  await withTempDatabase(
    Effect.gen(function* () {
      yield* (yield* AutomationCatalog).seedSystemAutomations([eventsHandler.spec])
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
              item: { item_id: "item-1", title: "Hi", sender: "", received_at: "", snippet: "" }
            }
          }
        ]
      })
      const [lease] = yield* claimAll("scope")
      if (lease === undefined) return yield* Effect.die("Events was not claimed")
      const { run } = yield* startJob(lease, "scope-run")
      expect((yield* (yield* RunQueries).get(run.runId))?.metadata["run_policy"]).toMatchObject({
        capabilities: ["read_only"]
      })
    })
  )
})

it("a mail the owner sent is no new mail for any Automation", () => {
  const mail = {
    itemId: "item-1",
    source: "gmail",
    threadKey: "thread-1",
    title: "Re: Interview",
    sender: "Me <me@x.test>",
    receivedAt: "2026-11-18T09:00:00.000Z",
    snippet: "Tuesday works.",
    detail: undefined
  }
  expect(connectionItemEvent(mail)?.eventType).toBe("email.received")
  expect(connectionItemEvent({ ...mail, detail: { [SENT_BY_OWNER]: true } })).toBeUndefined()
})
