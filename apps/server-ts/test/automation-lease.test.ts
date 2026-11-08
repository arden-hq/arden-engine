import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { ChatWriteStore, type ChatWriteStartInput } from "../src/persistence/chat/store.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { AutomationId } from "../src/persistence/automations/model.js"

it("can send a Chat message after an automation adds a transcript-only headline", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const chat = yield* ChatWriteStore
      const sessions = yield* SessionStore
      const session = yield* sessions.create({ name: "Conversation" })
      const automation = yield* store.create(
        {
          history: "chat",
          name: "Headline",
          prompt: "Review",
          triggers: [{ type: "time", every: "1h" }],
          chat: { kind: "yours", session_id: session.sessionId },
          idempotency_key: "e4d5bd57-853c-4876-a87a-55e2b487616f",
          idempotency_scope: "global"
        },
        "owner"
      )
      yield* queue.requestRun(AutomationId.make(automation.task_id))
      const [lease] = yield* Effect.promise(async () =>
        queue.jobs.claim({
          workerId: "headline",
          now: Date.now(),
          limit: 1,
          leaseDurationMs: 30_000
        })
      )
      if (!lease) throw new Error("Missing automation lease")
      expect([lease.payload.chatKind, lease.payload.contextMode]).toEqual(["yours", "fork"])
      yield* queue.prepareRunSession(lease)
      const started = yield* chat.start({
        sessionId: session.sessionId,
        clientId: "reply",
        requestHash: "reply",
        assistantMessageId: "answer",
        message: {
          message_id: "reply",
          client_id: "reply",
          role: "user",
          content: "Continue",
          created_at: new Date().toISOString()
        }
      })
      expect(started._tag).toBe("Started")
    }).pipe(
      Effect.provide(
        sqlitePersistenceLayer({ dataDir: null, filename: ":memory:" }).pipe(
          Layer.provide(PersistenceWriteQueue.layer)
        )
      )
    )
  )
})

it("honors the owner's expiry when another worker requests a different lease duration", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const automation = yield* store.create(
        {
          history: "chat",
          name: "Expiry",
          prompt: "Review",
          triggers: [{ type: "time", every: "1h" }],
          idempotency_key: "98ee26ae-2a9b-48dd-842c-f358b4d36c09",
          idempotency_scope: "global"
        },
        "owner"
      )
      yield* queue.requestRun(AutomationId.make(automation.task_id))
      const now = Date.now()
      const first = (yield* Effect.promise(async () =>
        queue.jobs.claim({ workerId: "first", now, limit: 1, leaseDurationMs: 30_000 })
      ))[0]
      if (!first) return yield* Effect.die("Expected a lease")
      expect([first.payload.chatKind, first.payload.contextMode]).toEqual(["own", "continue"])
      expect(
        yield* Effect.promise(async () =>
          queue.jobs.claim({
            workerId: "early",
            now: now + 5_000,
            limit: 1,
            leaseDurationMs: 1_000
          })
        )
      ).toEqual([])
      const second = (yield* Effect.promise(async () =>
        queue.jobs.claim({
          workerId: "replacement",
          now: first.expiresAt,
          limit: 1,
          leaseDurationMs: 60_000
        })
      ))[0]
      expect(second).toMatchObject({
        id: first.id,
        attempt: first.attempt + 1,
        payload: first.payload,
        leasedAt: first.expiresAt,
        expiresAt: first.expiresAt + 60_000
      })
    }).pipe(
      Effect.provide(
        sqlitePersistenceLayer({ dataDir: null, filename: ":memory:" }).pipe(
          Layer.provide(PersistenceWriteQueue.layer)
        )
      )
    )
  )
})

it("rejects expired ownership before another worker reclaims it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const chat = yield* ChatWriteStore
      const automation = yield* store.create(
        {
          history: "chat",
          name: "Expired",
          prompt: "Review",
          triggers: [{ type: "time", every: "1h" }],
          idempotency_key: "18574a67-e61f-44ba-9cbe-53fa0b2787ae",
          idempotency_scope: "global"
        },
        "owner"
      )
      yield* queue.requestRun(AutomationId.make(automation.task_id))
      const now = Date.now()
      const lease = (yield* Effect.promise(async () =>
        queue.jobs.claim({
          workerId: "expired",
          now: now - 60_000,
          limit: 1,
          leaseDurationMs: 30_000
        })
      ))[0]
      if (!lease || !lease.payload.sessionId) return yield* Effect.die("Expected an expired lease")
      const sessionId = lease.payload.sessionId
      expect(
        (yield* chat
          .start({
            sessionId,
            clientId: "expired",
            requestHash: "expired",
            assistantMessageId: "expired:assistant",
            automationLease: lease,
            automation: {
              automationId: AutomationId.make(automation.task_id),
              name: automation.name,
              attemptId: lease.payload.automationRunId
            },
            automationContextMode: "continue",
            automationPrompt: "Review",
            message: {
              message_id: "expired",
              client_id: "expired",
              role: "user",
              content: "Review",
              created_at: new Date(now).toISOString(),
              automation: {
                context_mode: "continue",
                task_id: automation.task_id,
                name: automation.name,
                prompt: "Review"
              }
            }
          })
          .pipe(Effect.result))._tag
      ).toBe("Failure")
      expect((yield* queue.prepareRunSession(lease).pipe(Effect.result))._tag).toBe("Failure")
      yield* Effect.promise(async () => {
        await expect(
          queue.jobs.renew({
            ...lease,
            workerId: "expired",
            now: lease.expiresAt,
            leaseDurationMs: 30_000
          })
        ).rejects.toThrow()
        await expect(
          queue.jobs.complete({
            ...lease,
            completedAt: now,
            result: {
              status: "ended",
              outcome: "finished",
              result: "Stale",
              error: null,
              chatRunId: null,
              chatSessionId: sessionId
            }
          })
        ).rejects.toThrow()
        await expect(
          queue.jobs.fail({ ...lease, failedAt: now, error: "Stale", retryAt: now + 1_000 })
        ).rejects.toThrow()
        await expect(queue.jobs.release({ ...lease, releasedAt: now })).rejects.toThrow()
      })
      const replacement = (yield* Effect.promise(async () =>
        queue.jobs.claim({ workerId: "replacement", now, limit: 1, leaseDurationMs: 30_000 })
      ))[0]
      expect(replacement).toMatchObject({
        id: lease.id,
        attempt: lease.attempt + 1,
        payload: lease.payload
      })
    }).pipe(
      Effect.provide(
        sqlitePersistenceLayer({ dataDir: null, filename: ":memory:" }).pipe(
          Layer.provide(PersistenceWriteQueue.layer)
        )
      )
    )
  )
})

it.each([
  ["release", "owned"],
  ["expiry", "existing"]
] as const)(
  "keeps ownership across renewal and fences old work after %s and reclaim in %s Chat",
  async (handoff, target) => {
    const directory = await mkdtemp(join(tmpdir(), "arden-automation-lease-"))
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AutomationCatalog
          const queue = yield* AutomationQueue
          const chat = yield* ChatWriteStore
          const sessions = yield* SessionStore
          const destination =
            target === "existing" ? yield* sessions.create({ name: "Existing Chat" }) : null
          const automation = yield* store.create(
            {
              history: "chat",
              name: "Lease",
              prompt: "Review",
              triggers: [{ type: "time", every: "1h" }],
              ...(destination === null
                ? {}
                : { chat: { kind: "yours", session_id: destination.sessionId } }),
              idempotency_key: "1b6a9e13-cc9d-428b-8eac-541449343bc9",
              idempotency_scope: "global"
            },
            "owner"
          )
          yield* queue.requestRun(AutomationId.make(automation.task_id))
          const now = Date.now()
          const first = (yield* Effect.promise(async () =>
            queue.jobs.claim({ workerId: "first", now, limit: 1, leaseDurationMs: 30_000 })
          ))[0]
          if (!first || !first.payload.sessionId)
            return yield* Effect.die("Expected a claimed Session")
          const sessionId = first.payload.sessionId
          const request = {
            sessionId,
            clientId: "first",
            requestHash: "first",
            assistantMessageId: "assistant",
            automationLease: { id: first.id, token: first.token },
            automation: {
              automationId: AutomationId.make(automation.task_id),
              name: automation.name,
              attemptId: first.payload.automationRunId
            },
            automationContextMode: "continue",
            automationPrompt: "Review",
            message: {
              message_id: "first",
              client_id: "first",
              role: "user",
              content: "Review",
              created_at: new Date().toISOString(),
              automation: {
                context_mode: "continue",
                task_id: automation.task_id,
                name: automation.name,
                prompt: "Review"
              }
            }
          } satisfies ChatWriteStartInput
          const run = yield* chat.start(request)
          const renewed = yield* Effect.promise(async () =>
            queue.jobs.renew({
              ...first,
              workerId: "first",
              now: now + 15_000,
              leaseDurationMs: 30_000
            })
          )
          expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt)
          expect(renewed.payload).toEqual({
            ...first.payload,
            chatRun: { runId: run.runId, sessionId, authority: "active" }
          })
          const shorter = yield* Effect.promise(async () =>
            queue.jobs.renew({
              ...first,
              workerId: "first",
              now: now + 16_000,
              leaseDurationMs: 1_000
            })
          )
          expect(shorter.expiresAt).toBe(renewed.expiresAt)
          yield* chat.cancel({ runId: run.runId })
          if (handoff === "release")
            yield* Effect.promise(async () =>
              Promise.resolve(queue.jobs.release({ ...first, releasedAt: now + 16_000 }))
            )
          const replacementAt = now + (handoff === "release" ? 17_000 : 60_000)
          const second = (yield* Effect.promise(async () =>
            queue.jobs.claim({
              workerId: "second",
              now: replacementAt,
              limit: 1,
              leaseDurationMs: 30_000
            })
          ))[0]
          if (!second) return yield* Effect.die("Expected the replacement lease")
          expect(second.payload.automationRunId).toBe(first.payload.automationRunId)
          expect(second.attempt).toBe(first.attempt + 1)
          expect((yield* chat.start(request).pipe(Effect.result))._tag).toBe("Failure")
          expect(
            (yield* chat
              .start({
                ...request,
                clientId: "stale",
                requestHash: "stale",
                message: { ...request.message, message_id: "stale", client_id: "stale" }
              })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          const result = {
            status: "ended" as const,
            outcome: "finished" as const,
            result: "Replacement settled",
            error: null,
            chatRunId: run.runId,
            chatSessionId: sessionId
          }
          yield* Effect.promise(async () => {
            await expect(
              queue.jobs.complete({ ...first, completedAt: replacementAt + 1_000, result })
            ).rejects.toThrow()
            await expect(
              queue.jobs.renew({
                ...first,
                workerId: "first",
                now: replacementAt + 1_000,
                leaseDurationMs: 30_000
              })
            ).rejects.toThrow()
          })
          yield* Effect.promise(async () =>
            Promise.resolve(
              queue.jobs.complete({ ...second, completedAt: replacementAt + 1_000, result })
            )
          )
          expect((yield* store.runs(AutomationId.make(automation.task_id), 10))?.[0]).toMatchObject(
            { status: "completed", result: "Replacement settled" }
          )
        }).pipe(
          Effect.provide(
            sqlitePersistenceLayer({ dataDir: null, filename: join(directory, "arden.db") }).pipe(
              Layer.provide(PersistenceWriteQueue.layer)
            )
          )
        )
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
