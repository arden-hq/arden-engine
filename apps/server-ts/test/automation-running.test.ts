import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { automationsOfChat } from "../src/persistence/sqlite/automation-removal.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { changes, newAutomation, everyTrigger } from "./fixtures/automation-input.js"

it("an Automation whose job failed and waits for a retry is running, and stays", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const automation = yield* catalog.create(
        newAutomation({
          history: "chat",
          name: "Retrying",
          prompt: "Review",
          triggers: [everyTrigger("1h")],
          idempotency_key: "7c1e5b3a-2d4f-4a6b-8c9d-0e1f2a3b4c01"
        }),
        "owner"
      )
      const id = AutomationId.make(automation.task_id)
      yield* queue.requestRun(id)
      const now = Date.now()
      const [lease] = yield* Effect.promise(async () =>
        queue.jobs.claim({
          workerId: "running",
          now,
          limit: 1,
          leaseDurationMs: 30_000
        })
      )
      if (lease === undefined) return yield* Effect.die("Expected a lease")
      yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.fail({
            ...lease,
            failedAt: now,
            error: "Try again",
            retryAt: now + 60_000
          })
        )
      )
      const [run] = yield* sql<{ readonly started_at: string }>`
        SELECT started_at FROM automation_runs WHERE id = ${lease.payload.automationRunId}`
      expect((yield* catalog.get(id))?.activity).toEqual({
        kind: "running",
        since: run?.started_at
      })
      const refused = yield* catalog.delete(id).pipe(Effect.flip)
      expect(refused.reason).toBe("conflict")
    })
  )
})

it("an Automation waiting for a retry keeps its chat, and its chat cannot be deleted under it", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const sessions = yield* SessionStore
      const chat = yield* sessions.create({ name: "Conversation" })
      const automation = yield* catalog.create(
        newAutomation({
          history: "chat",
          name: "Retrying",
          prompt: "Review",
          triggers: [everyTrigger("1h")],
          chat: { kind: "yours", session_id: chat.sessionId },
          idempotency_key: "7c1e5b3a-2d4f-4a6b-8c9d-0e1f2a3b4c02"
        }),
        "owner"
      )
      const id = AutomationId.make(automation.task_id)
      yield* queue.requestRun(id)
      const now = Date.now()
      const [lease] = yield* Effect.promise(async () =>
        queue.jobs.claim({
          workerId: "running",
          now,
          limit: 1,
          leaseDurationMs: 30_000
        })
      )
      if (lease === undefined) return yield* Effect.die("Expected a lease")
      yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.fail({
            ...lease,
            failedAt: now,
            error: "Try again",
            retryAt: now + 60_000
          })
        )
      )
      expect(yield* automationsOfChat(sql, chat.sessionId)).toEqual([
        { task_id: automation.task_id, name: "Retrying", running: 1 }
      ])
      const refused = yield* catalog
        .update(id, changes({ kind: "chat", chat: { kind: "own" } }), "owner")
        .pipe(Effect.flip)
      expect(refused.reason).toBe("conflict")
      const archived = yield* sessions.archive(chat.sessionId).pipe(Effect.flip)
      expect(archived.reason).toBe("conflict")
    })
  )
})
