import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OperationalEvent } from "@arden-hq/protocol/daemon"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "vitest"
import { InboxStore } from "../src/persistence/inbox/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { diagnosticsLayer } from "../src/runtime/diagnostics.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"

const at = "2026-09-22T00:00:00.000Z"

const makeStorage = (filename: string, events: Array<OperationalEvent>) =>
  Layer.merge(
    sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
      Layer.provide(PersistenceWriteQueue.layer),
      Layer.provide(
        diagnosticsLayer({
          startupPhase: () => {},
          migration: () => {},
          operational: (event) => events.push(event)
        })
      )
    ),
    SqliteClient.layer({ filename })
  )

const insertSession = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string
    readonly parentId?: string
    readonly type: "agent" | "chat"
    readonly archived?: boolean
  }
) => sql`INSERT INTO sessions (
    session_id, public_ref, name, started_at, last_activity, archived_at,
    session_type, parent_session_id, parent_run_id, parent_tool_call_id
  ) VALUES (
    ${input.id}, ${`${input.id}-ref`}, ${input.id}, ${at}, ${at},
    ${input.archived === true ? at : null}, ${input.type}, ${input.parentId ?? null},
    ${input.type === "agent" ? `${input.id}-parent-run` : null},
    ${input.type === "agent" ? `${input.id}-spawn` : null}
  )`

const insertTerminalRun = (
  sql: SqlClient.SqlClient,
  runId: string,
  sessionId: string
) => sql`INSERT INTO chat_runs (
    run_id, session_id, status, started_at, updated_at, ended_at,
    metadata_json, assistant_message_id
  ) VALUES (${runId}, ${sessionId}, 'completed', ${at}, ${at}, ${at}, '{}', ${`${runId}-answer`})`

const insertDelivery = (
  sql: SqlClient.SqlClient,
  input: {
    readonly deliveryId: string
    readonly destinationId: string
    readonly sourceRunId: string
  }
) => sql`INSERT INTO automation_deliveries (
    delivery_id, subject, body, payload, status, created_at, destinations
  ) VALUES (
    ${input.deliveryId}, 'Worker completed', 'Durable result',
    ${JSON.stringify({
      kind: "result",
      sessionId: input.destinationId,
      context: { origin: { kind: "chat", session_id: "root", turn_id: "request" }, task: null },
      runIds: [input.sourceRunId],
      questionId: null
    })},
    'pending', ${at}, '[]'
  )`

describe("delivery reliability", () => {
  it("reroutes a terminal agent return to the nearest visible ancestor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-delivery-route-"))
    const filename = join(directory, "arden.db")
    const events: Array<OperationalEvent> = []
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const work = yield* WorkStore
          yield* insertSession(sql, { id: "root", type: "chat" })
          yield* insertSession(sql, { id: "parent-agent", parentId: "root", type: "agent" })
          yield* insertSession(sql, { id: "source-agent", parentId: "parent-agent", type: "agent" })
          yield* insertTerminalRun(sql, "source-run", "source-agent")
          const deliveryId = "a".repeat(64)
          yield* insertDelivery(sql, {
            deliveryId,
            destinationId: "parent-agent",
            sourceRunId: "source-run"
          })

          const pending = yield* work.pendingDeliveries()
          expect(pending).toHaveLength(1)
          expect(pending[0]).toMatchObject({
            deliveryId,
            attempt: 0,
            payload: {
              sessionId: "root",
              routing: { fromSessionId: "parent-agent", toSessionId: "root" }
            }
          })
          expect(events).toContainEqual(
            expect.objectContaining({
              code: "delivery.rerouted",
              deliveryId,
              sourceRunId: "source-run",
              fromSessionId: "parent-agent",
              toSessionId: "root",
              attempt: 0
            })
          )
        }).pipe(Effect.provide(makeStorage(filename, events)))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("creates one durable Inbox incident when no visible ancestor exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-delivery-incident-"))
    const filename = join(directory, "arden.db")
    const events: Array<OperationalEvent> = []
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const work = yield* WorkStore
          const inbox = yield* InboxStore
          yield* insertSession(sql, { id: "orphan-parent", parentId: "gone", type: "agent" })
          yield* insertSession(sql, {
            id: "orphan-source",
            parentId: "orphan-parent",
            type: "agent"
          })
          yield* insertTerminalRun(sql, "orphan-run", "orphan-source")
          const deliveryId = "b".repeat(64)
          yield* insertDelivery(sql, {
            deliveryId,
            destinationId: "orphan-parent",
            sourceRunId: "orphan-run"
          })

          expect(yield* work.pendingDeliveries()).toEqual([])
          const first = yield* inbox.view()
          expect(first.groups.find((group) => group.kind === "incidents")?.items).toEqual([
            expect.objectContaining({
              source: "incident",
              key: `delivery:${deliveryId}`,
              incidentId: `delivery:${deliveryId}`,
              code: "delivery.unroutable",
              deliveryId,
              sourceRunId: "orphan-run",
              unread: true
            })
          ])
          expect(yield* work.pendingDeliveries()).toEqual([])
          expect(
            (yield* inbox.view()).groups.find((group) => group.kind === "incidents")?.items
          ).toEqual(first.groups.find((group) => group.kind === "incidents")?.items)
          expect(events.filter((event) => event.code === "delivery.unroutable")).toHaveLength(1)

          const marked = yield* inbox.markRead({
            scope: "items",
            keys: [`delivery:${deliveryId}`]
          })
          expect(marked.groups.find((group) => group.kind === "incidents")?.items).toEqual([
            expect.objectContaining({
              incidentId: `delivery:${deliveryId}`,
              summary: expect.stringContaining("could not be delivered"),
              unread: false,
              readAt: expect.any(String)
            })
          ])
          const dismissed = yield* inbox.dismiss({
            scope: "items",
            keys: [`delivery:${deliveryId}`]
          })
          expect(dismissed.groups.some((group) => group.kind === "incidents")).toBe(false)
          expect((yield* inbox.view()).groups.some((group) => group.kind === "incidents")).toBe(
            false
          )
        }).pipe(Effect.provide(makeStorage(filename, events)))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("persists bounded retry state and attempts only due deliveries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-delivery-retry-"))
    const filename = join(directory, "arden.db")
    const events: Array<OperationalEvent> = []
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const work = yield* WorkStore
          yield* insertSession(sql, { id: "root", type: "chat" })
          yield* insertSession(sql, { id: "busy-root", type: "chat" })
          yield* insertSession(sql, { id: "source", parentId: "root", type: "agent" })
          yield* insertTerminalRun(sql, "source-run", "source")
          yield* sql`INSERT INTO chat_runs (
          run_id, session_id, status, started_at, updated_at, metadata_json, assistant_message_id
        ) VALUES ('busy', 'busy-root', 'running', ${at}, ${at}, '{}', 'busy-answer')`
          const deliveryId = "c".repeat(64)
          yield* insertDelivery(sql, {
            deliveryId,
            destinationId: "busy-root",
            sourceRunId: "source-run"
          })

          expect(yield* work.pendingDeliveries()).toEqual([])
          expect(yield* work.pendingDeliveries()).toEqual([])
          let state = (yield* sql<{
            readonly attempt_count: number
            readonly last_error: string
            readonly next_attempt_at: string
          }>`SELECT attempt_count, last_error, next_attempt_at FROM automation_deliveries
          WHERE delivery_id = ${deliveryId}`)[0]
          expect(state).toMatchObject({
            attempt_count: 1,
            last_error: "Arrival waits for the current Chat turn or pending approval"
          })
          expect(events.filter((event) => event.code === "delivery.retry_scheduled")).toHaveLength(
            1
          )

          yield* sql`UPDATE automation_deliveries SET next_attempt_at = ${at}, attempt_count = 5
          WHERE delivery_id = ${deliveryId}`
          expect(yield* work.pendingDeliveries()).toEqual([])
          state = (yield* sql<{
            readonly attempt_count: number
            readonly last_error: string
            readonly next_attempt_at: string
          }>`SELECT attempt_count, last_error, next_attempt_at FROM automation_deliveries
          WHERE delivery_id = ${deliveryId}`)[0]
          expect(state?.attempt_count).toBe(6)
          const last = events.filter((event) => event.code === "delivery.retry_scheduled").at(-1)
          expect(last).toMatchObject({ code: "delivery.retry_scheduled", attempt: 6 })
          if (last?.code !== "delivery.retry_scheduled" || state === undefined) {
            throw new Error("Missing retry evidence")
          }
          expect(
            Date.parse(state.next_attempt_at) - Date.parse(last.occurredAt)
          ).toBeGreaterThanOrEqual(29_000)
        }).pipe(Effect.provide(makeStorage(filename, events)))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
