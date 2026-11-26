import { ROLE } from "@arden-hq/std/message-vocabulary"
import { createToolset } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import type { ChatMessage } from "../src/chat/message.js"
import { eventsHandler, makeEventsRunner } from "../src/automations/handlers/events.js"
import { renderAutomationJob, withScreenedEvents } from "../src/automations/job-prompt.js"
import { screenEventWake } from "../src/automations/prefilter.js"
import type { PostMessageInput } from "../src/automations/post-message-tool.js"
import type { AwaitAutomationRun } from "../src/automations/runner.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import {
  AutomationQueue,
  type AutomationBlockedReport
} from "../src/persistence/automations/queue.js"
import type {
  AutomationJobResult,
  ClaimedAutomationJobLease
} from "../src/persistence/automations/store.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { PostStore } from "../src/persistence/posts/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { claimAll, startChat } from "./fixtures/job-runs.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-20T00:00:00.000Z"

interface FakeCall {
  readonly tool: string
  readonly args: object
  readonly content: string
  readonly isError?: boolean
}

interface FakeEnding {
  readonly reply?: string
  readonly blocked?: AutomationBlockedReport
  readonly noChange?: string
}

const fakeModel = (calls: ReadonlyArray<FakeCall>, ending: FakeEnding = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const chat = yield* ChatWriteStore
    const runs: Array<string> = []
    const startAutomation: ChatMessage["Service"]["startAutomation"] = (input) =>
      Effect.gen(function* () {
        const started = yield* startChat(input.sessionId, input.clientId, {
          automation: {
            automationId: input.automation.automationId,
            attemptId: input.automation.attemptId,
            lease: input.lease
          }
        })
        const runId = started.runId
        for (const [index, call] of calls.entries())
          yield* sql`INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name,
              arguments_json, changes_state, status, result_json, started_at, ended_at)
            VALUES (${runId}, ${input.sessionId}, ${`call-${index}`}, ${call.tool},
              ${JSON.stringify(call.args)}, 0, 'completed',
              ${JSON.stringify({ content: call.content, preview: "Done", is_error: call.isError ?? false })},
              ${AT}, ${AT})`
        if (ending.noChange !== undefined)
          yield* sql`UPDATE chat_runs
            SET metadata_json = json_set(metadata_json, '$.no_change_reason', ${ending.noChange})
            WHERE run_id = ${runId}`
        yield* chat.finish({
          runId,
          messages: [
            ...started.activeMessages,
            {
              message_id: `${input.clientId}-answer`,
              role: ROLE.assistant,
              content: ending.reply ?? "Done.",
              created_at: AT
            }
          ]
        })
        runs.push(runId)
        return { runId, sessionId: input.sessionId, status: "running" as const }
      }).pipe(Effect.orDie)
    const awaitRun: AwaitAutomationRun = () =>
      Effect.succeed({
        status: "completed",
        result: ending.reply ?? "Done.",
        error: null,
        errorCode: null,
        blocked: ending.blocked ?? null,
        noChange: ending.noChange ?? null,
        wrote: false
      })
    return { chat: { startAutomation }, awaitRun, runs }
  })

const eventsTools = (eventsHandler.tools ?? ((base) => base))(
  createToolset([], {
    toJsonSchema: (schema: Schema.Constraint) => Schema.toJsonSchemaDocument(schema).schema
  })(undefined)
)

const posting = (input: PostMessageInput) =>
  Effect.promise(async () => {
    const result = await eventsTools.execute({
      name: "post_message",
      args: input,
      toolCallId: "post"
    })
    return { tool: "post_message", args: input, content: result.content } satisfies FakeCall
  })

const mail = (itemId: string) => ({
  eventType: "email.received" as const,
  eventKey: itemId,
  producedBy: null,
  chainDepth: 0,
  context: {
    item: {
      item_id: itemId,
      title: `Mail ${itemId}`,
      sender: "A <a@x.test>",
      received_at: AT,
      snippet: "Can you confirm?"
    }
  }
})

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* (yield* AutomationCatalog).seedSystemAutomations([eventsHandler.spec])
  const queue = yield* AutomationQueue
  const posts = yield* PostStore
  const spaces = yield* SpaceStore
  const triggers = yield* AutomationTriggers
  const arrive = (...itemIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (const itemId of itemIds)
        yield* sql`INSERT OR IGNORE INTO connection_item_threads (item_id, source, account, thread_key)
          VALUES (${itemId}, 'gmail', 'me@example.com', ${`thread-of-${itemId}`})`
      yield* triggers.publishSourceEvents({
        eventType: "email.received",
        source: "made-up",
        cursor: itemIds.join(","),
        events: itemIds.map(mail)
      })
      const fresh = sql`claimed_at IS NULL AND source = 'event'
        AND task_id = ${eventsHandler.spec.automationId}`
      yield* sql`UPDATE automation_event_queue SET context = json_set(context, '$.event_batch',
          json_object('omitted', 0, 'events', json((SELECT json_group_array(json(json_patch(json_set(
            json_remove(json_extract(waiting.context, '$.trigger_context_snapshot'), '$.source'),
            '$.produced_by',
            json_extract(waiting.context, '$.trigger_context_snapshot.produced_by.automation_id')),
            json_object('run_only_if', json_extract(waiting.context, '$.run_only_if')))))
            FROM automation_event_queue AS waiting WHERE ${fresh}))))
        WHERE id = (SELECT MIN(id) FROM automation_event_queue WHERE ${fresh})`
      yield* sql`DELETE FROM automation_event_queue
        WHERE ${fresh} AND id <> (SELECT MIN(id) FROM automation_event_queue WHERE ${fresh})`
      const lease = (yield* claimAll(`events-${itemIds.join("-")}`)).find(
        (claimed) => claimed.payload.automationId === eventsHandler.spec.automationId
      )
      if (lease === undefined) return yield* Effect.die("Events was not claimed")
      return lease
    })
  const runEvents = (
    lease: ClaimedAutomationJobLease,
    calls: ReadonlyArray<FakeCall>,
    ending: FakeEnding = {}
  ) =>
    Effect.gen(function* () {
      const model = yield* fakeModel(calls, ending)
      const result = yield* makeEventsRunner({ ...model, queue, posts })(renderAutomationJob(lease))
      return { result, runs: model.runs }
    })
  const settle = (lease: ClaimedAutomationJobLease, result: AutomationJobResult) =>
    Effect.promise(async () =>
      Promise.resolve(
        queue.jobs.complete({ ...lease, completedAt: lease.expiresAt - 1_000, result })
      )
    )
  const drain = Effect.gen(function* () {
    for (const pending of yield* posts.pendingDeliveries()) yield* posts.deliver(pending)
  })
  const postedIn = (sessionId: string) =>
    sql<{ readonly role: string; readonly content: string }>`
      SELECT json_extract(message_json, '$.role') AS role,
        json_extract(message_json, '$.content') AS content
      FROM session_messages WHERE session_id = ${sessionId} ORDER BY seq`
  return { sql, queue, spaces, arrive, runEvents, settle, drain, postedIn }
})

it("post_message posts in the named Space, and a retried job posts nothing twice", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, arrive, runEvents, drain, postedIn } = yield* setup
      const taxes = yield* spaces.create({ name: "Taxes", instructions: { kind: "unwritten" } })
      const lease = yield* arrive("mail-1")
      const call = yield* posting({
        space_id: taxes.space_id,
        text: "The bank needs a form by Friday."
      })
      const first = yield* runEvents(lease, [call])
      expect(first.result).toMatchObject({ status: "ended", outcome: "finished" })
      const runId = first.result.chatRunId
      const sessionId = first.result.chatSessionId
      if (runId === null || sessionId === null) return yield* Effect.die("the run has no chat")
      const reclaimed = {
        ...lease,
        payload: {
          ...lease.payload,
          chatRun: { runId, sessionId, authority: "active" as const }
        }
      }
      const again = yield* runEvents(reclaimed, [call])
      expect(again.result).toMatchObject({ status: "ended", outcome: "finished" })
      yield* drain
      const [chat] = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM sessions WHERE space_id = ${taxes.space_id}`
      if (chat === undefined) return yield* Effect.die("no Space chat")
      expect(yield* postedIn(chat.session_id)).toEqual([
        { role: ROLE.assistant, content: "The bank needs a form by Friday." }
      ])
      expect(yield* sql`SELECT 1 FROM automation_deliveries`).toHaveLength(1)
    })
  )
})

it("report no_change followed by free text posts nothing and completes with no change", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, arrive, runEvents } = yield* setup
      const { result } = yield* runEvents(
        yield* arrive("mail-1"),
        [{ tool: "report", args: { event: "no_change" }, content: "Recorded." }],
        { reply: "Nothing here matches the rule.", noChange: "A newsletter." }
      )
      expect(result).toMatchObject({
        status: "ended",
        outcome: "no_change",
        result: "A newsletter."
      })
      expect(yield* sql`SELECT 1 FROM automation_deliveries`).toEqual([])
    })
  )
})

it("a refused post_message followed by free text ends failed, not with no change", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, arrive, runEvents } = yield* setup
      const { result } = yield* runEvents(
        yield* arrive("mail-1"),
        [{ ...(yield* posting({ text: "Refused." })), isError: true }],
        { reply: "I tried to tell you about a mail." }
      )
      expect(result).toMatchObject({
        status: "ended",
        outcome: "failed",
        result: "I tried to tell you about a mail."
      })
      expect(yield* sql`SELECT 1 FROM automation_deliveries`).toEqual([])
    })
  )
})

it("a post with a task starts it in the post's Space, under the message; a second event of the thread starts none", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, arrive, runEvents, settle, drain } = yield* setup
      const home = yield* spaces.create({ name: "Home", instructions: { kind: "unwritten" } })
      const task = { title: "Send the form", brief: "Fill in the bank form and send it." }
      const lease = yield* arrive("mail-1")
      const first = yield* runEvents(lease, [
        yield* posting({ space_id: home.space_id, text: "The bank needs a form.", task })
      ])
      yield* settle(lease, first.result)
      yield* drain
      yield* sql`INSERT INTO connection_item_threads (item_id, source, account, thread_key)
        VALUES ('mail-2', 'gmail', 'me@example.com', 'thread-of-mail-1')`
      const second = yield* arrive("mail-2")
      yield* runEvents(second, [yield* posting({ text: "The bank sent a reminder.", task })])
      yield* drain
      const tasks = yield* sql<{
        readonly space_id: string
        readonly text: string
        readonly origin_message_id: string
      }>`SELECT space_id, text, origin_message_id FROM space_tasks`
      const posted = yield* sql<{ readonly message_id: string; readonly session_id: string }>`
        SELECT message_id, session_id FROM session_messages
        WHERE session_id IN (SELECT session_id FROM sessions WHERE space_id = ${home.space_id})
        ORDER BY message_rowid`
      expect(tasks).toEqual([
        { space_id: home.space_id, text: "Send the form", origin_message_id: posted[0]?.message_id }
      ])
      expect(posted).toHaveLength(2)
      expect(posted[1]?.session_id).toBe(posted[0]?.session_id)
    })
  )
})

it("Events gets the item ids of the screened batch only, so a skipped mail is neither mapped nor cited", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, queue, arrive, runEvents, drain } = yield* setup
      const lease = yield* arrive("kept", "skipped")
      expect(lease.payload).toMatchObject({ handler: "events" })
      expect(lease.payload.handler === "events" ? [...lease.payload.itemIds].sort() : []).toEqual([
        "kept",
        "skipped"
      ])
      const decide = (request: { readonly state: { readonly event: string } }) =>
        Effect.succeed({
          by: "decision_model" as const,
          value: request.state.event.includes("Mail kept"),
          backend: "test",
          probability: 0.9
        })
      const decisions = { decide } as unknown as Parameters<typeof screenEventWake>[0]
      const verdict = yield* screenEventWake(decisions)(lease)
      if (verdict === undefined) return yield* Effect.die("the wake was not screened")
      const screen = yield* queue.recordEventScreen({
        lease,
        screen: verdict,
        now: lease.expiresAt - 1_000
      })
      if (screen.kind !== "run") return yield* Effect.die("the batch was skipped")
      const screened = withScreenedEvents(lease, screen)
      expect(screened.payload).toMatchObject({ handler: "events", itemIds: ["kept"] })
      yield* runEvents(screened, [
        yield* posting({ text: "Kept mail.", task: { title: "Answer", brief: "Answer the mail." } })
      ])
      yield* drain
      expect(yield* sql`SELECT thread_key FROM event_threads`).toEqual([
        { thread_key: "thread-of-kept" }
      ])
      expect(
        yield* sql`SELECT json_extract(source, '$.item_id') AS item_id FROM space_task_sources
          WHERE json_extract(source, '$.kind') = 'connection_item'`
      ).toEqual([{ item_id: "kept" }])
    })
  )
})

it("Events keeps listening after runs that fail one after another", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, arrive, settle } = yield* setup
      for (const itemId of ["mail-1", "mail-2", "mail-3", "mail-4"])
        yield* settle(yield* arrive(itemId), {
          status: "ended",
          outcome: "failed",
          result: null,
          error: "The model is down.",
          chatRunId: null,
          chatSessionId: null
        })
      expect(
        yield* sql`SELECT enabled, paused_at FROM scheduled_tasks
          WHERE task_id = ${eventsHandler.spec.automationId}`
      ).toEqual([{ enabled: 1, paused_at: null }])
      expect(yield* sql`SELECT 1 FROM entity_events WHERE event = 'paused'`).toEqual([])
    })
  )
})

it("a run that reports it is blocked ends blocked with its reason, and posts nothing", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, arrive, runEvents } = yield* setup
      const { result } = yield* runEvents(
        yield* arrive("mail-1"),
        [{ tool: "report", args: { event: "blocked" }, content: "Recorded." }],
        {
          reply: "I could not read the mail.",
          blocked: { kind: "dependency", reason: "The mail could not be read." }
        }
      )
      expect(result).toMatchObject({
        status: "ended",
        outcome: "blocked",
        result: "I could not read the mail.",
        error: "The mail could not be read."
      })
      expect(yield* sql`SELECT 1 FROM automation_deliveries`).toEqual([])
    })
  )
})

it("a no-change verdict counts only while it still holds", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, queue, arrive } = yield* setup
      const lease = yield* arrive("mail-1")
      const sessionId = yield* queue.prepareRunSession(renderAutomationJob(lease))
      const started = yield* startChat(sessionId, "verdict", {
        automation: {
          automationId: lease.payload.automationId,
          attemptId: lease.payload.automationRunId,
          lease: { id: lease.id, token: lease.token }
        }
      })
      const report = (id: string, event: string, at: string) =>
        sql`INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name, arguments_json,
            changes_state, status, result_json, started_at, ended_at, effect)
          VALUES (${started.runId}, ${sessionId}, ${id}, 'report', ${JSON.stringify({ event })},
            0, 'completed', '{"content":"Recorded.","preview":"Recorded"}', ${at}, ${at},
            'run_record')`
      yield* report("no-change", "no_change", "2026-11-20T00:00:01.000Z")
      yield* sql`UPDATE chat_runs
        SET metadata_json = json_set(metadata_json, '$.no_change_reason', 'A newsletter.')
        WHERE run_id = ${started.runId}`
      yield* (yield* ChatWriteStore).finish({
        runId: started.runId,
        messages: [
          ...started.activeMessages,
          { message_id: "verdict-answer", role: ROLE.assistant, content: "Done.", created_at: AT }
        ]
      })
      const verdict = Effect.map(queue.observeChatRun(started.runId), (observed) =>
        observed !== null && "noChange" in observed ? observed.noChange : undefined
      )
      expect(yield* verdict).toBe("A newsletter.")
      yield* report("news", "news", "2026-11-20T00:00:02.000Z")
      expect(yield* verdict).toBeNull()
    })
  )
})

it("a job with no item to check ends without starting a run", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { arrive, runEvents } = yield* setup
      const lease = yield* arrive("mail-1")
      const empty = {
        ...lease,
        payload: { ...lease.payload, handler: "events" as const, itemIds: [] }
      }
      const { result, runs } = yield* runEvents(empty, [])
      expect(result).toMatchObject({
        status: "ended",
        outcome: "no_input",
        chatRunId: null,
        chatSessionId: null
      })
      expect(runs).toEqual([])
    })
  )
})
