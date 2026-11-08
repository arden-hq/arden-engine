import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

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

it("moves a script through attempts, settles once and queues one result per settle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-script-store-"))
  const filename = join(directory, "arden.db")
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const writer = makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
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
          {
            discard: true
          }
        )
        const store = makeScriptStore({ writer, sessionEvents: sessionLifecycleFixture })
        const created = yield* store.create(origin)
        yield* store.progress({
          ref: origin.ref,
          attempt: 1,
          data: { phases: ["Review"], agents: [{ key: "a" }] }
        })
        yield* store.progress({ ref: origin.ref, attempt: 1, data: { phases: [], agents: [] } })
        const replayed = yield* store.create(origin)
        const otherRef = yield* reason(store.create({ ...origin, ref: "wf-2" }))
        const retryWhileRunning = yield* reason(store.retry({ ref: "wf-1", expectedVersion: 1 }))
        const second = yield* store.nextAttempt({ ref: "wf-1", attempt: 1, auto: true })
        yield* store.progress({ ref: origin.ref, attempt: 1, data: { phases: ["stale"] } })
        yield* store.progress({ ref: origin.ref, attempt: 2, data: { phases: [], agents: [] } })
        const executions = yield* readScriptExecutions(sql, origin)
        const staleAttempt = yield* reason(
          store.nextAttempt({ ref: "wf-1", attempt: 1, auto: true })
        )
        const staleSettle = yield* store.settle({ ref: "wf-1", attempt: 1, settlement: failed })
        const settled = yield* store.settle({ ref: "wf-1", attempt: 2, settlement: failed })
        const settledAgain = yield* store.settle({ ref: "wf-1", attempt: 2, settlement: failed })
        const oldVersion = yield* reason(store.retry({ ref: "wf-1", expectedVersion: 1 }))
        const retried = yield* store.retry({ ref: "wf-1", expectedVersion: settled?.version ?? 0 })
        const running = yield* store.running()
        const cancelled = yield* store.cancel("wf-1")
        const cancelledAgain = yield* store.cancel("wf-1")
        const results = yield* sql<{ readonly body: string; readonly payload: string }>`
          SELECT body, payload FROM automation_deliveries ORDER BY created_at, body`
        return {
          executions,
          created,
          replayed: replayed.version,
          otherRef,
          retryWhileRunning,
          second: [second.attempt, second.autoRetries, second.version],
          staleAttempt,
          staleSettle,
          settled: [settled?.status, settled?.error?.code, settled?.endedAt !== null],
          settledAgain,
          oldVersion,
          retried: [retried.status, retried.attempt, retried.autoRetries, retried.error],
          running: running.map((record) => record.ref),
          cancelled: [cancelled.status, cancelled.attempt],
          cancelledAgain: cancelledAgain.version === cancelled.version,
          results: results.map((row) => {
            const payload = JSON.parse(row.payload)
            return [row.body, payload.attempt, payload.status]
          })
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(SqliteClient.layer({ filename }), PersistenceWriteQueue.layer)
        )
      )
    )
    expect(result).toEqual({
      executions: [
        { attempt: 1, data: { phases: ["Review"], agents: [{ key: "a" }] } },
        { attempt: 2, data: { phases: [], agents: [] } }
      ],
      created: {
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
      },
      replayed: 1,
      otherRef: "conflict",
      retryWhileRunning: "conflict",
      second: [2, 1, 2],
      staleAttempt: "conflict",
      staleSettle: undefined,
      settled: ["failed", "agent_failed", true],
      settledAgain: undefined,
      oldVersion: "conflict",
      retried: ["running", 3, 0, null],
      running: ["wf-1"],
      cancelled: ["cancelled", 3],
      cancelledAgain: true,
      results: [
        ["An agent failed", 2, "failed"],
        ["The script was cancelled", 3, "cancelled"]
      ]
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
