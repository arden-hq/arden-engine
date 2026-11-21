import type { OperationalEvent } from "@arden-hq/protocol/daemon"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"
import { ChatMessage } from "../src/chat/message.js"
import type { ChatRunner } from "../src/chat/runner-contract.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { drainOutbox } from "../src/runtime/outbox.js"
import { workArrivals } from "../src/work/arrivals-runtime.js"
import {
  admissionCounts,
  arrivalsLayer,
  deliveryIdOf,
  holdChat,
  insertOriginChat,
  insertPendingArrival,
  openTurn,
  readDelivery,
  stopsAfterOneAdmission,
  withArrivalsDatabase
} from "./fixtures/work-arrivals.js"

const receipts = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql<{
    readonly client_id: string
    readonly run_id: string | null
    readonly status: string
  }>`SELECT client_id, run_id, status FROM chat_idempotency_keys
    WHERE session_id = ${sessionId} AND client_id LIKE 'arrival:%' ORDER BY created_at, client_id`

const settled = (sessionId: string, destination: string) => ({
  status: "delivered",
  delivered_at: expect.any(String),
  destinations: JSON.stringify([`chat:${destination}`]),
  attempt_count: 0,
  next_attempt_at: null,
  last_error: null,
  session_id: sessionId
})

describe("the work arrivals adapter", () => {
  it("settles the admitted arrivals of a batch and retries only the refused one", async () => {
    const events: Array<OperationalEvent> = []
    await withArrivalsDatabase((filename) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sessions = yield* SessionStore
          const work = yield* WorkStore
          const chat = yield* ChatMessage
          yield* insertOriginChat(sql)
          const busy = yield* sessions.create({ name: "Busy chat" })
          const held = yield* sessions.create({ name: "Held chat" })
          yield* holdChat(sql, yield* ChatWriteStore, held.sessionId)
          const starts = yield* insertPendingArrival(sql, {
            name: "starts",
            sessionId: busy.sessionId,
            parentId: "origin",
            createdAt: "2026-11-01T00:00:01.000Z"
          })
          const queues = yield* insertPendingArrival(sql, {
            name: "queues",
            sessionId: busy.sessionId,
            parentId: "origin",
            createdAt: "2026-11-01T00:00:02.000Z"
          })
          const refused = yield* insertPendingArrival(sql, {
            name: "refused",
            sessionId: busy.sessionId,
            parentId: "origin",
            kind: "answer",
            createdAt: "2026-11-01T00:00:03.000Z"
          })
          const stored = yield* insertPendingArrival(sql, {
            name: "stored",
            sessionId: held.sessionId,
            parentId: "origin",
            createdAt: "2026-11-01T00:00:04.000Z"
          })

          expect(yield* drainOutbox(workArrivals(work, chat))).toBe(1)

          const admitted = yield* receipts(sql, busy.sessionId)
          const runId = admitted[0]?.run_id
          if (runId === null || runId === undefined) throw new Error("The batch started no run")
          expect(admitted).toEqual([
            { client_id: `arrival:${starts}`, run_id: runId, status: "running" },
            { client_id: `arrival:${queues}`, run_id: runId, status: "queued" }
          ])
          expect(yield* readDelivery(sql, starts)).toEqual([settled(busy.sessionId, runId)])
          expect(yield* readDelivery(sql, queues)).toEqual([settled(busy.sessionId, runId)])
          expect(yield* readDelivery(sql, refused)).toEqual([
            {
              status: "pending",
              delivered_at: null,
              destinations: "[]",
              attempt_count: 1,
              next_attempt_at: expect.any(String),
              last_error: expect.stringContaining("Arrival waits for the current Chat turn"),
              session_id: busy.sessionId
            }
          ])
          expect(yield* receipts(sql, held.sessionId)).toEqual([
            { client_id: `arrival:${stored}`, run_id: null, status: "accepted" }
          ])
          expect(yield* readDelivery(sql, stored)).toEqual([
            settled(held.sessionId, held.sessionId)
          ])
          expect(
            events.flatMap((event) =>
              event.code === "delivery.retry_scheduled" ? [event.deliveryId] : []
            )
          ).toEqual([refused])

          const alone = yield* insertPendingArrival(sql, {
            name: "alone",
            sessionId: busy.sessionId,
            parentId: "origin",
            createdAt: "2026-11-01T00:00:05.000Z"
          })
          const untouched = yield* readDelivery(sql, alone)
          expect(
            yield* chat
              .send({
                sessionId: busy.sessionId,
                clientId: `arrival:${alone}`,
                deliveryId: alone,
                message: "Result of alone",
                isMeta: true
              })
              .pipe(Effect.flip)
          ).toMatchObject({
            _tag: "ChatMessageConflictError",
            message: "Arrival waits for the current Chat turn"
          })
          expect(yield* readDelivery(sql, alone)).toEqual(untouched)
          expect(untouched).toMatchObject([{ status: "pending", attempt_count: 0 }])
        }).pipe(
          Effect.provide(arrivalsLayer({ filename, runner: openTurn, events })),
          Effect.scoped
        )
      )
    )
  })

  it("keeps an arrival settled when the server stops before the launch, and the next boot runs it once", async () => {
    await withArrivalsDatabase(async (filename) => {
      const deliveryId = deliveryIdOf("before-launch")
      const launched: Array<string> = []
      const resumed = Promise.withResolvers<string>()
      const runner: ChatRunner = async function* ({ runId, signal }) {
        launched.push(runId)
        resumed.resolve(runId)
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        throw new Error("The test closed this turn")
      }

      const stopped = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sessions = yield* SessionStore
          const work = yield* WorkStore
          const chat = yield* ChatMessage
          const arrivals = workArrivals(work, chat)
          yield* insertOriginChat(sql)
          const { sessionId } = yield* sessions.create({ name: "Destination" })
          yield* insertPendingArrival(sql, {
            name: "before-launch",
            sessionId,
            parentId: "origin"
          })

          expect(yield* drainOutbox(arrivals)).toBe(1)
          const [receipt] = yield* receipts(sql, sessionId)
          const runId = receipt?.run_id
          if (runId === null || runId === undefined) throw new Error("The arrival started no run")
          const row = yield* readDelivery(sql, deliveryId)
          expect(row).toEqual([settled(sessionId, runId)])
          expect(launched).toEqual([])

          yield* work.deferDelivery(deliveryId, "The run was not launched")
          expect(yield* drainOutbox(arrivals)).toBe(0)
          expect(yield* readDelivery(sql, deliveryId)).toEqual(row)
          return { sessionId, runId, row }
        }).pipe(
          Effect.provide(arrivalsLayer({ filename, runner, lifecycle: stopsAfterOneAdmission })),
          Effect.scoped
        )
      )
      expect(launched).toEqual([])

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const work = yield* WorkStore
          const chat = yield* ChatMessage

          expect(yield* Effect.promise(() => resumed.promise)).toBe(stopped.runId)
          expect(yield* drainOutbox(workArrivals(work, chat))).toBe(0)
          expect(yield* readDelivery(sql, deliveryId)).toEqual(stopped.row)
          expect(yield* admissionCounts(sql, stopped.sessionId, deliveryId)).toEqual({
            receipts: 1,
            messages: 1,
            runs: 1
          })
          expect(launched).toEqual([stopped.runId])
        }).pipe(Effect.provide(arrivalsLayer({ filename, runner })), Effect.scoped)
      )
    })
  })
})
