import { createToolset } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { dailySummaryHandler } from "../src/automations/handlers/daily-summary.js"
import { eventsHandler } from "../src/automations/handlers/events.js"
import { connectionItemEvent } from "../src/automations/producers/connection-item.js"
import { SENT_BY_OWNER } from "../src/connections/items/gmail.js"
import { screenEventWake } from "../src/automations/prefilter.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import type { AutomationJobLeaseRef } from "../src/persistence/automations/store.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { PROMPTS } from "../src/prompts/catalog.js"
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
      const refused = yield* catalog
        .update(
          dailySummaryHandler.spec.automationId,
          { triggers: [{ type: "event", event_type: "email.received", run_only_if: SENTENCE }] },
          "owner"
        )
        .pipe(Effect.flip)
      expect(refused.message).toBe("This system Automation's triggers take no run_only_if sentence")
    })
  )
})

it("the check of an event reads what is known about the owner when the job gives it", async () => {
  const states: Array<unknown> = []
  const decide = (request: { readonly state: unknown }) => {
    states.push(request.state)
    return Effect.succeed({
      by: "decision_model" as const,
      value: false,
      backend: "test",
      probability: 0.9
    })
  }
  const job = {
    payload: {
      occurrence: "event",
      chatRun: null,
      prefilter: {
        events: [
          { key: "email.received:1", sentences: [SENTENCE], prompt: "A mail arrived.", event: null }
        ]
      }
    }
  } as unknown as AutomationJobLeaseRef
  const decisions = { decide } as unknown as Parameters<typeof screenEventWake>[0]
  const alone = await Effect.runPromise(screenEventWake(decisions)(job))
  const withOwner = await Effect.runPromise(
    screenEventWake(decisions, () => Effect.succeed("Looks for a job."))(job)
  )
  expect(states).toEqual([
    { event: "A mail arrived." },
    { event: "A mail arrived.", owner: "Looks for a job." }
  ])
  expect(alone?.skipped.map((skip) => skip.key)).toEqual(["email.received:1"])
  expect(withOwner?.passed).toEqual([])
})

it("seeding over Urgent events names the row and its chat Events, keeps the rule and history, and resets the prompt", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const events = eventsHandler.spec.automationId
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      const rule = [
        { type: "event" as const, event_type: "email.received" as const, run_only_if: SENTENCE }
      ]
      yield* catalog.update(events, { triggers: rule }, "owner")
      yield* sql`UPDATE scheduled_tasks SET name = 'Urgent events', handler = 'urgent_events',
          prompt = 'Tell me what is urgent.', prompt_author = 'owner'
        WHERE task_id = ${events}`
      yield* sql`UPDATE sessions SET name = 'Urgent events' WHERE origin_automation_id = ${events}`
      yield* sql`INSERT INTO automation_runs (task_id, started_at, status)
        VALUES (${events}, '2026-11-18T09:00:00.000Z', 'completed')`
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      expect(
        yield* sql`SELECT name, handler, prompt, prompt_author, triggers_source
          FROM scheduled_tasks WHERE task_id = ${events}`
      ).toEqual([
        {
          name: "Events",
          handler: "events",
          prompt: PROMPTS.events,
          prompt_author: null,
          triggers_source: "manual"
        }
      ])
      expect(yield* sql`SELECT name FROM sessions WHERE origin_automation_id = ${events}`).toEqual([
        { name: "Events" }
      ])
      expect(yield* sql`SELECT 1 FROM automation_runs WHERE task_id = ${events}`).toHaveLength(1)
      const seeded = yield* catalog.get(events)
      expect(seeded?.triggers).toMatchObject(rule)
      expect(seeded?.system?.settable).toEqual(["triggers", "model", "enabled"])
      const refused = yield* catalog
        .update(events, { prompt: "Tell me everything." }, "owner")
        .pipe(Effect.flip)
      expect(refused.message).toBe(
        "A system Automation cannot change prompt. It accepts only triggers, model, enabled."
      )
    })
  )
})

it("seeding resumes an Events row that paused itself, with its own schedule, and leaves one turned off", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const events = eventsHandler.spec.automationId
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      yield* catalog.update(
        events,
        {
          triggers: [
            { type: "time", at: "08:00", days: "daily" },
            { type: "event", event_type: "email.received", run_only_if: SENTENCE }
          ]
        },
        "owner"
      )
      const pause = (autoResumeAt: string | null) =>
        sql`UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL,
            paused_at = '2026-11-18T09:00:00.000Z', auto_resume_at = ${autoResumeAt},
            auto_resumes = 1, failed_runs = 2
          WHERE task_id = ${events}`
      const state = sql<{
        readonly enabled: number
        readonly armed: number
        readonly paused_at: string | null
        readonly auto_resume_at: string | null
        readonly auto_resumes: number
        readonly failed_runs: number
      }>`SELECT enabled, next_run_at IS NOT NULL AS armed, paused_at, auto_resume_at,
          auto_resumes, failed_runs
        FROM scheduled_tasks WHERE task_id = ${events}`
      yield* pause("2026-11-18T10:00:00.000Z")
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      expect(yield* state).toEqual([
        {
          enabled: 1,
          armed: 1,
          paused_at: null,
          auto_resume_at: null,
          auto_resumes: 0,
          failed_runs: 0
        }
      ])
      yield* pause(null)
      yield* catalog.seedSystemAutomations([eventsHandler.spec])
      expect(yield* state).toEqual([
        {
          enabled: 0,
          armed: 0,
          paused_at: "2026-11-18T09:00:00.000Z",
          auto_resume_at: null,
          auto_resumes: 1,
          failed_runs: 2
        }
      ])
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
  expect(JSON.stringify(added[0]?.parameters)).toContain('"maxLength":1500')
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
