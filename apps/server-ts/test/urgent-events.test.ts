import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { dailySummaryHandler } from "../src/automations/handlers/daily-summary.js"
import { urgentEventsHandler } from "../src/automations/handlers/urgent-events.js"
import { screenEventWake } from "../src/automations/prefilter.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import type { AutomationJobLeaseRef } from "../src/persistence/automations/store.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { recentNotices } from "../src/persistence/sqlite/notices.js"
import { claimAll, startJob } from "./fixtures/job-runs.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const SENTENCE = "It is from my bank."

it("Urgent events keeps a Run only if sentence the owner rewrote and resets it; no other built-in takes one", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      yield* catalog.seedSystemAutomations([urgentEventsHandler.spec, dailySummaryHandler.spec])
      const urgent = urgentEventsHandler.spec.automationId
      const rewritten = yield* catalog.update(
        urgent,
        { triggers: [{ type: "event", event_type: "email.received", run_only_if: SENTENCE }] },
        "owner"
      )
      expect(rewritten?.triggers).toMatchObject([
        { event_type: "email.received", run_only_if: SENTENCE }
      ])
      expect(rewritten?.system?.changed).toContain("triggers")
      const reset = yield* catalog.resetSystemSetting(urgent, "triggers")
      expect(reset?.triggers).toMatchObject(urgentEventsHandler.spec.triggers)
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

it("an arrival wakes Urgent events with the owner's sentence, and its reply is one the owner is told", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const triggers = yield* AutomationTriggers
      const chat = yield* ChatWriteStore
      yield* catalog.seedSystemAutomations([urgentEventsHandler.spec])
      const published = yield* triggers.publishSourceEvents({
        eventType: "email.received",
        source: "made-up",
        cursor: "1",
        events: [
          {
            eventType: "email.received",
            eventKey: "item-1",
            producedBy: null,
            chainDepth: 0,
            context: {
              item: {
                item_id: "item-1",
                title: "Interview on Tuesday",
                sender: "A <a@x.test>",
                received_at: "2026-11-18T09:00:00.000Z",
                snippet: "Can you confirm?"
              }
            }
          }
        ]
      })
      expect(published.queued).toBe(1)
      const [lease] = yield* claimAll("urgent")
      if (lease === undefined) throw new Error("Urgent events was not claimed")
      expect(lease.payload.handler).toBe("urgent_events")
      expect(lease.payload.prefilter?.events.map((event) => event.sentences)).toEqual([
        [
          urgentEventsHandler.spec.triggers[0]?.type === "event"
            ? urgentEventsHandler.spec.triggers[0].run_only_if
            : ""
        ]
      ])
      expect(lease.payload.prefilter?.events[0]?.prompt).toContain("Interview on Tuesday")
      const { run, sessionId } = yield* startJob(lease, "alert")
      const at = new Date().toISOString()
      yield* chat.finish({
        runId: run.runId,
        messages: [
          ...run.activeMessages,
          {
            message_id: "alert-answer",
            role: "assistant",
            content: "A recruiter asks you to confirm Tuesday.",
            created_at: at
          }
        ]
      })
      // The job settles as the handler does after its run ends: only then is the ending decided.
      const queue = yield* AutomationQueue
      yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.complete({
            ...lease,
            completedAt: lease.expiresAt - 1_000,
            result: {
              status: "ended",
              outcome: "finished",
              result: "A recruiter asks you to confirm Tuesday.",
              error: null,
              chatRunId: run.runId,
              chatSessionId: sessionId
            }
          })
        )
      )
      const notices = yield* recentNotices(sql, { since: "2000-01-01T00:00:00.000Z", limit: 10 })
      expect(notices).toMatchObject([
        {
          status: "finished",
          shown: true,
          purpose: "user_automation",
          title: "Urgent events",
          text: "A recruiter asks you to confirm Tuesday.",
          automationId: urgentEventsHandler.spec.automationId
        }
      ])
    })
  )
})
