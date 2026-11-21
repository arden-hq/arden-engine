import type { ServerEvent } from "@arden-hq/protocol"
import { noticeOfEvent, notifyOwner } from "@arden-hq/protocol/notifications"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { dailySummaryHandler } from "../src/automations/handlers/daily-summary.js"
import { urgentEventsHandler } from "../src/automations/handlers/urgent-events.js"
import { connectionItemEvent } from "../src/automations/producers/connection-item.js"
import { SENT_BY_OWNER } from "../src/connections/items/gmail.js"
import { screenEventWake } from "../src/automations/prefilter.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import type { AutomationJobLeaseRef } from "../src/persistence/automations/store.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { announceNotice, recentNotices } from "../src/persistence/sqlite/notices.js"
import type { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { reconcileEndings } from "../src/persistence/sqlite/run-ending.js"
import { SessionReadState } from "../src/persistence/sessions/read-state.js"
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

it("each arrival wakes Urgent events with the owner's sentence, and every alert is one the owner is told in its chat", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const triggers = yield* AutomationTriggers
      const chat = yield* ChatWriteStore
      const queue = yield* AutomationQueue
      const readState = yield* SessionReadState
      yield* catalog.seedSystemAutomations([urgentEventsHandler.spec])
      // One made-up mail goes the whole way: published, claimed, run, finished, settled.
      const alert = (id: string, title: string, reply: string) =>
        Effect.gen(function* () {
          const published = yield* triggers.publishSourceEvents({
            eventType: "email.received",
            source: "made-up",
            cursor: id,
            events: [
              {
                eventType: "email.received",
                eventKey: id,
                producedBy: null,
                chainDepth: 0,
                context: {
                  item: {
                    item_id: id,
                    title,
                    sender: "A <a@x.test>",
                    received_at: "2026-11-18T09:00:00.000Z",
                    snippet: "Can you confirm?"
                  }
                }
              }
            ]
          })
          expect(published.queued).toBe(1)
          const [lease] = yield* claimAll(`urgent-${id}`)
          if (lease === undefined) throw new Error("Urgent events was not claimed")
          // As the handler does: each alert runs in a run Session under the Automation's chat.
          const { run, sessionId } = yield* startJob(
            lease,
            `alert-${id}`,
            yield* queue.prepareRunSession(lease)
          )
          yield* chat.finish({
            runId: run.runId,
            messages: [
              ...run.activeMessages,
              {
                message_id: `alert-${id}-answer`,
                role: ROLE.assistant,
                content: reply,
                created_at: new Date().toISOString()
              }
            ]
          })
          // The job settles as the handler does after its run ends: only then is the ending decided.
          yield* Effect.promise(async () =>
            Promise.resolve(
              queue.jobs.complete({
                ...lease,
                completedAt: lease.expiresAt - 1_000,
                result: {
                  status: "ended",
                  outcome: "finished",
                  result: reply,
                  error: null,
                  chatRunId: run.runId,
                  chatSessionId: sessionId
                }
              })
            )
          )
          return { lease, runSession: sessionId }
        })
      const { lease: first, runSession: firstRun } = yield* alert(
        "item-1",
        "Interview on Tuesday",
        "A recruiter asks you to confirm Tuesday."
      )
      expect(first.payload.handler).toBe("urgent_events")
      expect(first.payload.prefilter?.events.map((event) => event.sentences)).toEqual([
        [
          urgentEventsHandler.spec.triggers[0]?.type === "event"
            ? urgentEventsHandler.spec.triggers[0].run_only_if
            : ""
        ]
      ])
      expect(first.payload.prefilter?.events[0]?.prompt).toContain("Interview on Tuesday")
      // A later alert is news too: it is not held back as a repeat of the first.
      const { lease: second, runSession: secondRun } = yield* alert(
        "item-2",
        "Offer expires today",
        "An offer needs your answer today."
      )
      const urgentChat = second.payload.sessionId
      if (urgentChat === null) throw new Error("Urgent events has no chat")
      const told = yield* sql<{ readonly session_id: string; readonly weight: string }>`
        SELECT json_extract(payload, '$.sessionId') AS session_id,
          json_extract(payload, '$.update.weight') AS weight
        FROM automation_deliveries WHERE json_extract(payload, '$.kind') = 'update'`
      expect(told).toEqual([
        { session_id: urgentChat, weight: "news" },
        { session_id: urgentChat, weight: "news" }
      ])
      const notices = yield* recentNotices(sql, { since: "2000-01-01T00:00:00.000Z", limit: 10 })
      expect(notices.map((notice) => notice.text).toSorted()).toEqual([
        "A recruiter asks you to confirm Tuesday.",
        "An offer needs your answer today."
      ])
      // Each notice opens the Urgent events chat the alert was told in, not the run Session no
      // list shows.
      expect(notices).toMatchObject([
        { ...toldIn(urgentChat), purpose: "user_automation", title: "Urgent events" },
        { ...toldIn(urgentChat), purpose: "user_automation", title: "Urgent events" }
      ])
      expect(new Set(notices.map((notice) => notice.key)).size).toBe(2)
      // Each still comes from its own run, so on the phone neither alert replaces the other.
      expect(notices.map((notice) => notice.sourceSessionId).toSorted()).toEqual(
        [firstRun, secondRun].toSorted()
      )
      // The update is queued, not yet in the chat, so the chat holds nothing unread yet.
      expect(notices.map((notice) => notice.unread)).toEqual([false, false])
      // Each is an alert the owner asked to be told, so the desktop shows it at its default level.
      expect(notices.map((notice) => notice.alert)).toEqual([true, true])
      const announced: Array<ServerEvent> = []
      const events = {
        appendEventInTransaction: (event: ServerEvent) =>
          Effect.sync(() => {
            announced.push(event)
          })
      } as unknown as SessionLifecycleEvents["Service"]
      for (const notice of notices) yield* announceNotice(sql, events, notice.key)
      expect(announced).toMatchObject([
        { type: "record_told", alert: true, chat_session_id: urgentChat },
        { type: "record_told", alert: true, chat_session_id: urgentChat }
      ])
      const defaultLevel = announced.map((event) =>
        event.type === "record_told"
          ? notifyOwner({ record: noticeOfEvent(event), level: "needs_you", inFront: false })
          : false
      )
      expect(defaultLevel).toEqual([true, true])

      // Settling again after a restart tells nothing twice and changes no notice.
      yield* reconcileEndings(sql)
      expect(
        yield* sql`SELECT 1 FROM automation_deliveries WHERE json_extract(payload, '$.kind') = 'update'`
      ).toHaveLength(2)
      expect(yield* recentNotices(sql, { since: "2000-01-01T00:00:00.000Z", limit: 10 })).toEqual(
        notices
      )

      // Reading the chat answers nothing and removes no notice.
      yield* readState.mark(urgentChat)
      expect(yield* recentNotices(sql, { since: "2000-01-01T00:00:00.000Z", limit: 10 })).toEqual(
        notices
      )
    })
  )
})

const toldIn = (chatSessionId: string) => ({
  status: "finished",
  shown: true,
  chatSessionId
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
