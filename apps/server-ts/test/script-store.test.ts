import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import { scriptSchemaSection } from "../src/persistence/schema/sections/scripts.js"
import { contextExecutionSchemaSection } from "../src/persistence/schema/sections/context-execution.js"
import { makeWriter } from "../src/persistence/sqlite/deps.js"
import { readScriptExecutions } from "../src/persistence/sqlite/script-executions.js"
import { makeScriptStore } from "../src/persistence/sqlite/script-store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sessionLifecycleFixture } from "./session-lifecycle-fixture.js"

const origin = {
  ref: "wf-1",
  originSessionRef: "chat-ref",
  originRunId: "run-1",
  originToolCallId: "call-1",
  profileHash: "profile-1"
}

const failed = {
  status: "failed",
  value: null,
  error: {
    code: "agent_failed",
    message: "An agent failed",
    retryable: true,
    recovery_action: "retry"
  },
  sourceRefs: []
} as const

const reason = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "ok" }))

type Store = ReturnType<typeof makeScriptStore>
type Sql = SqlClient.SqlClient

const withStore = async <A>(
  run: (store: Store, sql: Sql) => Effect.Effect<A, unknown, never>
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-script-store-"))
  const filename = join(directory, "arden.db")
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const writer = makeWriter({
          sql,
          reader: sql,
          queue: yield* PersistenceWriteQueue
        })
        yield* sql.unsafe(
          "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, public_ref TEXT NOT NULL UNIQUE)"
        )
        yield* sql.unsafe("INSERT INTO sessions VALUES ('chat', 'chat-ref')")
        yield* sql.unsafe(`CREATE TABLE automation_deliveries (
          delivery_id TEXT PRIMARY KEY, task_id TEXT, delivered_at TEXT, subject TEXT NOT NULL,
          body TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
          destinations TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT, last_error TEXT
        )`)
        yield* Effect.forEach(
          [...contextExecutionSchemaSection.statements, ...scriptSchemaSection.statements],
          (statement) => sql.unsafe(statement),
          { discard: true }
        )
        const store = makeScriptStore({
          writer,
          sessionEvents: sessionLifecycleFixture
        })
        return yield* run(store, sql)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(SqliteClient.layer({ filename }), PersistenceWriteQueue.layer)
        )
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const results = (sql: Sql) =>
  Effect.map(
    sql<{ readonly body: string; readonly payload: string }>`
      SELECT body, payload FROM automation_deliveries ORDER BY created_at, body`,
    (rows) =>
      rows.map((row) => {
        const payload = JSON.parse(row.payload)
        return [row.body, payload.attempt, payload.status]
      })
  )

describe("a script store", () => {
  it("starts a script running and replays the same start without a new version", async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(origin)
        const replayed = yield* store.create(origin)
        return { created, replayed: replayed.version }
      })
    )
    expect(result.created).toEqual({
      ...origin,
      originSessionId: "chat",
      status: "running",
      version: 1,
      attempt: 1,
      autoRetries: 0,
      error: null,
      createdAt: result.created.createdAt,
      updatedAt: result.created.createdAt,
      endedAt: null
    })
    expect(result.replayed).toBe(1)
  })

  it("refuses a second script for the same origin under another ref", async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(origin)
        return yield* reason(store.create({ ...origin, ref: "wf-2" }))
      })
    )
    expect(result).toBe("conflict")
  })

  it("keeps each attempt's progress and drops progress from a stale attempt", async () => {
    const result = await withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.create(origin)
        yield* store.progress({
          ref: origin.ref,
          attempt: 1,
          data: { phases: ["Review"], agents: [{ key: "a" }] }
        })
        yield* store.progress({
          ref: origin.ref,
          attempt: 1,
          data: { phases: [], agents: [] }
        })
        yield* store.nextAttempt({ ref: "wf-1", attempt: 1, auto: true })
        yield* store.progress({
          ref: origin.ref,
          attempt: 1,
          data: { phases: ["stale"] }
        })
        yield* store.progress({
          ref: origin.ref,
          attempt: 2,
          data: { phases: [], agents: [] }
        })
        return yield* readScriptExecutions(sql, origin)
      })
    )
    expect(result).toEqual([
      { attempt: 1, data: { phases: ["Review"], agents: [{ key: "a" }] } },
      { attempt: 2, data: { phases: [], agents: [] } }
    ])
  })

  it("starts the next attempt only from the current one, and not while it is still running", async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(origin)
        const retryWhileRunning = yield* reason(store.retry({ ref: "wf-1", expectedVersion: 1 }))
        const second = yield* store.nextAttempt({
          ref: "wf-1",
          attempt: 1,
          auto: true
        })
        const staleAttempt = yield* reason(
          store.nextAttempt({ ref: "wf-1", attempt: 1, auto: true })
        )
        return {
          retryWhileRunning,
          second: [second.attempt, second.autoRetries, second.version],
          staleAttempt
        }
      })
    )
    expect(result).toEqual({
      retryWhileRunning: "conflict",
      second: [2, 1, 2],
      staleAttempt: "conflict"
    })
  })

  it("settles once, ignoring a stale or repeated settle", async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(origin)
        yield* store.nextAttempt({ ref: "wf-1", attempt: 1, auto: true })
        const staleSettle = yield* store.settle({
          ref: "wf-1",
          attempt: 1,
          settlement: failed
        })
        const settled = yield* store.settle({
          ref: "wf-1",
          attempt: 2,
          settlement: failed
        })
        const settledAgain = yield* store.settle({
          ref: "wf-1",
          attempt: 2,
          settlement: failed
        })
        return {
          staleSettle,
          settled: [settled?.status, settled?.error?.code, settled?.endedAt !== null],
          settledAgain
        }
      })
    )
    expect(result).toEqual({
      staleSettle: undefined,
      settled: ["failed", "agent_failed", true],
      settledAgain: undefined
    })
  })

  it("retries a settled script from its current version and counts attempts from there", async () => {
    const result = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(origin)
        yield* store.nextAttempt({ ref: "wf-1", attempt: 1, auto: true })
        const settled = yield* store.settle({
          ref: "wf-1",
          attempt: 2,
          settlement: failed
        })
        const oldVersion = yield* reason(store.retry({ ref: "wf-1", expectedVersion: 1 }))
        const retried = yield* store.retry({
          ref: "wf-1",
          expectedVersion: settled?.version ?? 0
        })
        const manual = yield* store.nextAttempt({
          ref: "wf-1",
          attempt: 3,
          auto: false
        })
        const running = yield* store.running()
        return {
          oldVersion,
          retried: [retried.status, retried.attempt, retried.autoRetries, retried.error],
          manual: [manual.attempt, manual.autoRetries],
          running: running.map((record) => record.ref)
        }
      })
    )
    expect(result).toEqual({
      oldVersion: "conflict",
      retried: ["running", 3, 0, null],
      manual: [4, 0],
      running: ["wf-1"]
    })
  })

  it("queues one result per settle and cancels once", async () => {
    const result = await withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.create(origin)
        yield* store.nextAttempt({ ref: "wf-1", attempt: 1, auto: true })
        const settled = yield* store.settle({
          ref: "wf-1",
          attempt: 2,
          settlement: failed
        })
        yield* store.settle({ ref: "wf-1", attempt: 2, settlement: failed })
        yield* store.retry({
          ref: "wf-1",
          expectedVersion: settled?.version ?? 0
        })
        yield* store.nextAttempt({ ref: "wf-1", attempt: 3, auto: false })
        const cancelled = yield* store.cancel("wf-1")
        const cancelledAgain = yield* store.cancel("wf-1")
        return {
          cancelled: [cancelled.status, cancelled.attempt],
          cancelledAgain: cancelledAgain.version === cancelled.version,
          results: yield* results(sql)
        }
      })
    )
    expect(result).toEqual({
      cancelled: ["cancelled", 4],
      cancelledAgain: true,
      results: [
        ["An agent failed", 2, "failed"],
        ["The script was cancelled", 4, "cancelled"]
      ]
    })
  })
})
