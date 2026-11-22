import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { recentNotices } from "../src/persistence/sqlite/notices.js"
import { claimAll } from "./fixtures/job-runs.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

type Lease = Effect.Success<ReturnType<typeof claimAll>>[number]

it("a user's Automation that runs in its own chat: the notice opens that chat", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const automation = yield* catalog.create(
        {
          history: "fresh",
          name: "Morning check",
          prompt: "Check",
          triggers: [{ type: "time", every: "1h" }],
          idempotency_key: "0d6f5e0a-5d0c-4d7e-9a43-6f5b8f0c2a11",
          idempotency_scope: "global"
        },
        "owner"
      )
      yield* queue.requestRun(AutomationId.make(automation.task_id))
      const [lease] = yield* claimAll("own")
      if (lease?.payload.sessionId == null) throw new Error("Morning check has no chat")
      const own = lease.payload.sessionId
      yield* settleRun(lease, own, "All quiet this morning.")
      expect(yield* notices()).toMatchObject([{ title: "Morning check", chatSessionId: own }])
    })
  )
})

it("a user's Automation that reads your chat runs in a fork; the notice opens the fork, also after the Automation is deleted", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const sessions = yield* SessionStore
      const yours = yield* sessions.create({ name: "My chat" })
      yield* sayHello(yours.sessionId)
      const automation = yield* catalog.create(
        {
          history: "chat",
          name: "Follow up",
          prompt: "Follow up",
          triggers: [{ type: "time", every: "1h" }],
          chat: { kind: "yours", session_id: yours.sessionId },
          idempotency_key: "7c1d8f7e-2b8a-4b0e-8f45-0a9c3e2d1b77",
          idempotency_scope: "global"
        },
        "owner"
      )
      const automationId = AutomationId.make(automation.task_id)
      yield* queue.requestRun(automationId)
      const [lease] = yield* claimAll("fork")
      if (lease === undefined) throw new Error("Follow up was not claimed")
      expect([lease.payload.chatKind, lease.payload.contextMode]).toEqual(["yours", "fork"])
      const fork = yield* queue.prepareForkSession(lease)
      if (fork === null) throw new Error("No fork was prepared")
      yield* settleRun(lease, fork.sessionId, "You asked me to follow up: done.")
      const followUp = (yield* notices()).filter((notice) => notice.title === "Follow up")
      expect(followUp).toMatchObject([{ chatSessionId: fork.sessionId }])

      yield* catalog.delete(automationId)
      expect(
        (yield* notices())
          .filter((notice) => notice.key === followUp[0]?.key)
          .map((notice) => notice.chatSessionId)
      ).toEqual([fork.sessionId])
    })
  )
})

const notices = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* recentNotices(sql, { since: "2000-01-01T00:00:00.000Z", limit: 10 })
  })

const sayHello = (sessionId: string) =>
  Effect.gen(function* () {
    const chat = yield* ChatWriteStore
    const started = yield* chat.start({
      sessionId,
      clientId: "hello",
      requestHash: "hello",
      assistantMessageId: "hello-answer",
      message: {
        message_id: "hello",
        client_id: "hello",
        role: ROLE.user,
        content: "Hello",
        created_at: new Date().toISOString()
      }
    })
    if (started._tag !== "Started") throw new Error("The owner's message did not start")
    yield* chat.finish({
      runId: started.runId,
      messages: [
        ...started.activeMessages,
        {
          message_id: "hello-answer",
          role: ROLE.assistant,
          content: "Hi.",
          created_at: new Date().toISOString()
        }
      ]
    })
  })

const settleRun = (lease: Lease, sessionId: string, reply: string) =>
  Effect.gen(function* () {
    const chat = yield* ChatWriteStore
    const queue = yield* AutomationQueue
    const id = `run-${lease.payload.automationRunId}`
    const contextMode = lease.payload.contextMode
    const started = yield* chat.start({
      sessionId,
      clientId: id,
      requestHash: `${id}-hash`,
      assistantMessageId: `${id}-answer`,
      message: {
        message_id: id,
        client_id: id,
        created_at: new Date().toISOString(),
        role: ROLE.interaction,
        kind: "assignment",
        from: { source: "automation", id: lease.payload.automationId, name: lease.payload.name },
        content: "Made-up prompt",
        automation: {
          task_id: lease.payload.automationId,
          name: lease.payload.name,
          prompt: "Made-up prompt",
          context_mode: contextMode
        }
      },
      automation: {
        automationId: AutomationId.make(lease.payload.automationId),
        attemptId: lease.payload.automationRunId,
        name: lease.payload.name
      },
      automationLease: { id: lease.id, token: lease.token },
      automationPrompt: "Made-up prompt",
      automationContextMode: contextMode
    })
    if (started._tag !== "Started") throw new Error(`Run ${id} did not start: ${started._tag}`)
    yield* chat.finish({
      runId: started.runId,
      messages: [
        ...started.activeMessages,
        {
          message_id: `${id}-answer`,
          role: ROLE.assistant,
          content: reply,
          created_at: new Date().toISOString()
        }
      ]
    })
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
            chatRunId: started.runId,
            chatSessionId: sessionId
          }
        })
      )
    )
  })
