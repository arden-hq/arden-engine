import {
  INTERACTION_KIND,
  INTERACTION_OUTCOME,
  INTERACTION_SOURCE
} from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"
import { ChatMessage } from "../src/chat/message.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { workflowDeliveryClientId } from "../src/persistence/chat/workflow-delivery.js"
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
  resultSendInput,
  strandDelivery,
  stranded,
  strandedAt,
  withArrivalsDatabase
} from "./fixtures/work-arrivals.js"

const receiptRun = (sql: SqlClient.SqlClient, sessionId: string, deliveryId: string) =>
  sql<{ readonly run_id: string | null }>`SELECT run_id FROM chat_idempotency_keys
    WHERE session_id = ${sessionId} AND client_id = ${`arrival:${deliveryId}`}`.pipe(
    Effect.map((rows) => rows[0]?.run_id ?? null)
  )

describe("a replayed arrival admission", () => {
  it("repairs the pending row of its started run once", async () => {
    await withArrivalsDatabase((filename) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sessions = yield* SessionStore
          const work = yield* WorkStore
          const chat = yield* ChatMessage
          const arrivals = workArrivals(work, chat)
          const { sessionId } = yield* sessions.create({ name: "Destination" })
          const deliveryId = yield* insertPendingArrival(sql, {
            name: "started",
            sessionId,
            parentId: sessionId
          })
          const [delivery] = yield* work.pendingDeliveries()
          if (delivery === undefined) throw new Error("The arrival is not pending")
          const input = resultSendInput(delivery)

          expect(yield* drainOutbox(arrivals)).toBe(1)
          const runId = yield* receiptRun(sql, sessionId, deliveryId)
          if (runId === null) throw new Error("The arrival started no run")
          expect(yield* readDelivery(sql, deliveryId)).toEqual([
            {
              status: "delivered",
              delivered_at: expect.any(String),
              destinations: JSON.stringify([`chat:${runId}`]),
              attempt_count: 0,
              next_attempt_at: null,
              last_error: null,
              session_id: sessionId
            }
          ])

          yield* strandDelivery(sql, deliveryId)
          expect(yield* drainOutbox(arrivals)).toBe(1)
          const repaired = yield* readDelivery(sql, deliveryId)
          expect(repaired).toEqual([
            {
              status: "delivered",
              delivered_at: expect.any(String),
              destinations: JSON.stringify([`chat:${runId}`]),
              attempt_count: 3,
              next_attempt_at: strandedAt,
              last_error: "Seeded pending beside its receipt",
              session_id: sessionId
            }
          ])

          expect(yield* chat.send(input)).toEqual({
            runId,
            sessionId,
            status: "running",
            clientId: input.clientId
          })
          expect(yield* readDelivery(sql, deliveryId)).toEqual(repaired)
          expect(yield* admissionCounts(sql, sessionId, deliveryId)).toEqual({
            receipts: 1,
            messages: 1,
            runs: 1
          })
        }).pipe(Effect.provide(arrivalsLayer({ filename, runner: openTurn })), Effect.scoped)
      )
    )
  })

  it("repairs the pending row of its stored message once, to the chat", async () => {
    await withArrivalsDatabase((filename) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sessions = yield* SessionStore
          const work = yield* WorkStore
          const chat = yield* ChatMessage
          const { sessionId } = yield* sessions.create({ name: "Held" })
          yield* holdChat(sql, yield* ChatWriteStore, sessionId)
          yield* insertOriginChat(sql)
          const deliveryId = yield* insertPendingArrival(sql, {
            name: "stored",
            sessionId,
            parentId: "origin"
          })
          const [delivery] = yield* work.pendingDeliveries()
          if (delivery === undefined) throw new Error("The arrival is not pending")
          const input = resultSendInput(delivery)
          const stored = { runId: null, sessionId, status: "accepted", clientId: input.clientId }

          expect(yield* drainOutbox(workArrivals(work, chat))).toBe(0)
          expect(yield* readDelivery(sql, deliveryId)).toEqual([
            {
              status: "delivered",
              delivered_at: expect.any(String),
              destinations: JSON.stringify([`chat:${sessionId}`]),
              attempt_count: 0,
              next_attempt_at: null,
              last_error: null,
              session_id: sessionId
            }
          ])

          yield* strandDelivery(sql, deliveryId)
          expect(yield* drainOutbox(workArrivals(work, chat))).toBe(0)
          const repaired = yield* readDelivery(sql, deliveryId)
          expect(repaired).toEqual([
            {
              status: "delivered",
              delivered_at: expect.any(String),
              destinations: JSON.stringify([`chat:${sessionId}`]),
              attempt_count: 3,
              next_attempt_at: strandedAt,
              last_error: "Seeded pending beside its receipt",
              session_id: sessionId
            }
          ])

          expect(yield* chat.send(input)).toEqual(stored)
          expect(yield* readDelivery(sql, deliveryId)).toEqual(repaired)
          expect(yield* admissionCounts(sql, sessionId, deliveryId)).toEqual({
            receipts: 1,
            messages: 1,
            runs: 1
          })
        }).pipe(Effect.provide(arrivalsLayer({ filename, runner: openTurn })), Effect.scoped)
      )
    )
  })

  it("leaves the row alone unless it is this receipt's own pending arrival", async () => {
    await withArrivalsDatabase((filename) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sessions = yield* SessionStore
          const work = yield* WorkStore
          const chat = yield* ChatMessage
          yield* insertOriginChat(sql)
          const names = [
            "wrong-hash",
            "malformed-receipt",
            "cross-session-run",
            "not-work",
            "wrong-body",
            "missing",
            "delivered",
            "discarded"
          ] as const
          const chats = new Map<string, string>()
          for (const name of names) {
            const { sessionId } = yield* sessions.create({ name })
            chats.set(name, sessionId)
            yield* insertPendingArrival(sql, { name, sessionId, parentId: "origin" })
          }
          const inputs = new Map(
            (yield* work.pendingDeliveries()).map((delivery) => [
              delivery.deliveryId,
              resultSendInput(delivery)
            ])
          )
          expect(yield* drainOutbox(workArrivals(work, chat))).toBe(names.length)
          const admitted = Effect.fn(function* (name: (typeof names)[number]) {
            const deliveryId = deliveryIdOf(name)
            const sessionId = chats.get(name)
            const input = inputs.get(deliveryId)
            if (sessionId === undefined || input === undefined)
              throw new Error(`No admitted arrival named ${name}`)
            const runId = yield* receiptRun(sql, sessionId, deliveryId)
            if (runId === null) throw new Error(`The arrival ${name} started no run`)
            yield* strandDelivery(sql, deliveryId)
            return {
              deliveryId,
              sessionId,
              input,
              receipt: { runId, sessionId, status: "running", clientId: input.clientId }
            }
          })

          const wrongHash = yield* admitted("wrong-hash")
          expect(
            yield* chat.send({ ...wrongHash.input, wake: false }).pipe(Effect.flip)
          ).toMatchObject({
            _tag: "ChatMessageConflictError",
            message: "The client id was already used for a different request"
          })
          expect(yield* readDelivery(sql, wrongHash.deliveryId)).toEqual([
            stranded(wrongHash.sessionId)
          ])

          const malformed = yield* admitted("malformed-receipt")
          yield* sql`UPDATE chat_idempotency_keys SET run_id = NULL, status = 'cancelled'
            WHERE session_id = ${malformed.sessionId} AND client_id = ${malformed.input.clientId}`
          expect(yield* chat.send(malformed.input).pipe(Effect.flip)).toMatchObject({
            _tag: "ChatMessageError",
            message: "Idempotency receipt has no run id"
          })
          expect(yield* readDelivery(sql, malformed.deliveryId)).toEqual([
            stranded(malformed.sessionId)
          ])

          const crossSession = yield* admitted("cross-session-run")
          yield* sql`UPDATE chat_idempotency_keys SET run_id = ${wrongHash.receipt.runId}
            WHERE session_id = ${crossSession.sessionId}
              AND client_id = ${crossSession.input.clientId}`
          expect(yield* chat.send(crossSession.input).pipe(Effect.flip)).toMatchObject({
            _tag: "ChatMessageError",
            message: "Idempotency receipt points to another run"
          })
          expect(yield* readDelivery(sql, crossSession.deliveryId)).toEqual([
            stranded(crossSession.sessionId)
          ])

          const notWork = yield* admitted("not-work")
          yield* sql`UPDATE automation_deliveries SET payload = json_set(payload, '$.kind', 'digest')
            WHERE delivery_id = ${notWork.deliveryId}`
          expect(yield* chat.send(notWork.input)).toEqual(notWork.receipt)
          expect(yield* readDelivery(sql, notWork.deliveryId)).toEqual([
            stranded(notWork.sessionId)
          ])

          const wrongBody = yield* admitted("wrong-body")
          yield* sql`UPDATE automation_deliveries SET body = 'Another result'
            WHERE delivery_id = ${wrongBody.deliveryId}`
          expect(yield* chat.send(wrongBody.input)).toEqual(wrongBody.receipt)
          expect(yield* readDelivery(sql, wrongBody.deliveryId)).toEqual([
            stranded(wrongBody.sessionId)
          ])

          const missing = yield* admitted("missing")
          yield* sql`DELETE FROM automation_deliveries WHERE delivery_id = ${missing.deliveryId}`
          expect(yield* chat.send(missing.input)).toEqual(missing.receipt)
          expect(yield* readDelivery(sql, missing.deliveryId)).toEqual([])

          for (const status of ["delivered", "discarded"] as const) {
            const settled = yield* admitted(status)
            yield* sql`UPDATE automation_deliveries SET status = ${status},
                delivered_at = '2026-11-01T00:00:01.000Z', destinations = '["chat:elsewhere"]'
              WHERE delivery_id = ${settled.deliveryId}`
            expect(yield* chat.send(settled.input)).toEqual(settled.receipt)
            expect(yield* readDelivery(sql, settled.deliveryId)).toEqual([
              {
                ...stranded(settled.sessionId),
                status,
                delivered_at: "2026-11-01T00:00:01.000Z",
                destinations: '["chat:elsewhere"]'
              }
            ])
          }
        }).pipe(Effect.provide(arrivalsLayer({ filename, runner: openTurn })), Effect.scoped)
      )
    )
  })

  it("does not let a Workflow result's receipt settle a work arrival", async () => {
    await withArrivalsDatabase((filename) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sessions = yield* SessionStore
          const chat = yield* ChatMessage
          yield* insertOriginChat(sql)
          const { sessionId } = yield* sessions.create({ name: "Workflow chat" })
          const workflowDelivery = { workflowRef: "workflow-fixture", attempt: 1 }
          const result = {
            sessionId,
            clientId: workflowDeliveryClientId(workflowDelivery),
            message: "Workflow finished",
            sender: {
              kind: INTERACTION_KIND.completion,
              from: { source: INTERACTION_SOURCE.workflow, id: workflowDelivery.workflowRef },
              outcome: INTERACTION_OUTCOME.completed
            },
            workflowDelivery
          } as const
          const started = yield* chat.send(result)
          const deliveryId = yield* insertPendingArrival(sql, {
            name: "beside-workflow",
            sessionId,
            parentId: "origin"
          })
          const pending = yield* readDelivery(sql, deliveryId)

          expect(
            yield* chat.send({ ...result, message: "Result of beside-workflow", deliveryId })
          ).toEqual(started)
          expect(yield* readDelivery(sql, deliveryId)).toEqual(pending)
          expect(pending).toMatchObject([{ status: "pending", session_id: sessionId }])
        }).pipe(Effect.provide(arrivalsLayer({ filename, runner: openTurn })), Effect.scoped)
      )
    )
  })

  it("returns a stale receipt after a reroute and leaves the row to its new chat", async () => {
    await withArrivalsDatabase((filename) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sessions = yield* SessionStore
          const work = yield* WorkStore
          const chat = yield* ChatMessage
          const arrivals = workArrivals(work, chat)
          yield* insertOriginChat(sql)
          const first = yield* sessions.create({ name: "First chat" })
          const second = yield* sessions.create({ name: "Second chat" })
          const deliveryId = yield* insertPendingArrival(sql, {
            name: "rerouted",
            sessionId: first.sessionId,
            parentId: "origin"
          })
          const [delivery] = yield* work.pendingDeliveries()
          if (delivery === undefined) throw new Error("The arrival is not pending")
          const input = resultSendInput(delivery)
          expect(yield* drainOutbox(arrivals)).toBe(1)
          const firstRun = yield* receiptRun(sql, first.sessionId, deliveryId)

          yield* strandDelivery(sql, deliveryId)
          yield* sql`UPDATE automation_deliveries
            SET payload = json_set(payload, '$.sessionId', ${second.sessionId})
            WHERE delivery_id = ${deliveryId}`
          expect(yield* chat.send(input)).toEqual({
            runId: firstRun,
            sessionId: first.sessionId,
            status: "running",
            clientId: input.clientId
          })
          expect(yield* readDelivery(sql, deliveryId)).toEqual([stranded(second.sessionId)])

          expect(yield* drainOutbox(arrivals)).toBe(1)
          const secondRun = yield* receiptRun(sql, second.sessionId, deliveryId)
          expect(secondRun).not.toBe(firstRun)
          expect(yield* readDelivery(sql, deliveryId)).toEqual([
            {
              ...stranded(second.sessionId),
              status: "delivered",
              delivered_at: expect.any(String),
              destinations: JSON.stringify([`chat:${secondRun}`])
            }
          ])
        }).pipe(Effect.provide(arrivalsLayer({ filename, runner: openTurn })), Effect.scoped)
      )
    )
  })
})
