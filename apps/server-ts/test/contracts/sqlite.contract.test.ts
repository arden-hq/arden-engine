import { makeJournalRuntime } from "@arden-hq/journal/effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { Stream } from "effect"
import { Effect, Layer, type Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"

import { makeWriter } from "../../src/persistence/sqlite/deps.js"
import { makeChatEventStore } from "../../src/persistence/sqlite/events.js"
import { initializeSchema } from "../fixtures/initialize-schema.js"
import { makeSessionLifecycleEvents } from "../../src/persistence/sqlite/lifecycle-events.js"
import { makeSessionStore } from "../../src/persistence/sqlite/sessions.js"
import { PersistenceWriteQueue } from "../../src/persistence/write-queue.js"
import type { ContractBackend, ContractPorts } from "./backend.js"
import { chatEventStoreContract } from "./chat-event-store.contract.js"
import { sessionLifecycleEventsContract } from "./session-lifecycle-events.contract.js"

const sqlite = {
  name: "SQLite",
  run: async <A>(
    test: (
      ports: ContractPorts & { readonly sql: SqlClient.SqlClient }
    ) => Effect.Effect<A, unknown, Scope.Scope>
  ): Promise<A> => {
    const directory = await mkdtemp(join(tmpdir(), "arden-contract-"))
    try {
      return await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const writer = makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
            yield* initializeSchema(sql)
            const journal = yield* makeJournalRuntime(sql, { initialize: false })
            const chatEvents = makeChatEventStore({ writer, journal })
            const sessionEvents = makeSessionLifecycleEvents({ writer, journal, chatEvents })
            const sessions = makeSessionStore({ writer, chatEvents, sessionEvents, reader: sql })
            return yield* test({
              sessions,
              sessionEvents,
              chatEvents,
              transact: writer.transact,
              sql
            })
          })
        ).pipe(
          Effect.provide(
            Layer.merge(
              SqliteClient.layer({ filename: join(directory, "arden.db") }),
              PersistenceWriteQueue.layer
            )
          )
        )
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
} satisfies ContractBackend

sessionLifecycleEventsContract(sqlite)
chatEventStoreContract(sqlite)

it("publishes the settled run identity in a terminal lifecycle row", () =>
  sqlite.run(({ sessions, sessionEvents, transact, sql }) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ name: "Settled child" })
      const opened = yield* sessionEvents.open()
      yield* transact(
        Effect.gen(function* () {
          yield* sql`INSERT INTO chat_runs (run_id, metadata_json, session_id, status, started_at, updated_at, ended_at, assistant_message_id)
          VALUES ('settled-run', '{"turn_id":"settled-turn"}',  ${session.sessionId}, 'completed', '2026-10-29T12:00:00Z', '2026-10-29T12:01:00Z', '2026-10-29T12:01:00Z', 'message')`
          yield* sessionEvents.appendInTransaction("session_activity", session.sessionId)
        })
      )
      const [delivery] = yield* opened.stream.pipe(Stream.take(1), Stream.runCollect)
      expect(delivery).toMatchObject({
        kind: "record",
        event: {
          type: "session_activity",
          session: {
            session_id: session.sessionId,
            active_run_id: null,
            latest_run_id: "settled-run",
            is_active: false
          }
        }
      })
    })
  ))

it("announces automation_progress to a follower without storing a row", () =>
  sqlite.run(({ sessionEvents, transact, sql }) =>
    Effect.gen(function* () {
      const opened = yield* sessionEvents.open()
      yield* transact(
        sessionEvents.appendEventInTransaction({
          type: "automation_progress",
          task_id: "progress-task",
          status: "starting..."
        })
      )
      const [delivery] = yield* opened.stream.pipe(Stream.take(1), Stream.runCollect)
      const stored =
        yield* sql`SELECT 1 FROM journal_records WHERE event_type = 'automation_progress'`
      expect(delivery).toMatchObject({
        kind: "record",
        replayed: false,
        event: { type: "automation_progress", task_id: "progress-task" }
      })
      expect(stored).toEqual([])
    })
  ))
