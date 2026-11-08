import { makeJournalRuntime } from "@arden-hq/journal/effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { makeSessionLifecycleEvents } from "../src/persistence/sqlite/lifecycle-events.js"
import { makeChatEventStore } from "../src/persistence/sqlite/events.js"
import { initializeSchema } from "./fixtures/initialize-schema.js"
import { makeSessionStore } from "../src/persistence/sqlite/sessions.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { makeWriter } from "../src/persistence/sqlite/deps.js"

const timestamp = "2026-01-01T00:00:00.000Z"

it("lists Sessions from the last commit while a writer transaction is open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-reader-connection-"))
  const filename = join(directory, "arden.db")
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const writes = yield* PersistenceWriteQueue
          yield* initializeSchema(sql)
          const journal = yield* makeJournalRuntime(sql, { initialize: false })
          const reader = yield* SqliteClient.make({ filename, readonly: true }).pipe(
            Effect.provide(Reactivity.layer)
          )
          const deps = { writer: makeWriter({ sql, reader, queue: writes }), reader }
          const chatEvents = makeChatEventStore({ ...deps, journal })
          const sessions = makeSessionStore({
            ...deps,
            chatEvents,
            sessionEvents: makeSessionLifecycleEvents({ ...deps, journal, chatEvents })
          })
          const names = sessions
            .list({ scope: "primary", limit: 10 })
            .pipe(Effect.map((rows) => rows.map((row) => row.name)))
          yield* sessions.create({ name: "Committed" })

          const held = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const writer = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
          INSERT INTO sessions (session_id, public_ref, name, started_at, last_activity)
          VALUES ('pending', 'pending-ref', 'Pending', ${timestamp}, ${timestamp})
        `
                yield* Deferred.succeed(held, undefined)
                yield* Deferred.await(release)
              })
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(held)
          const during = yield* names.pipe(Effect.timeout(Duration.seconds(2)))
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(writer)
          const after = yield* names
          return { during, after }
        })
      ).pipe(
        Effect.provide(Layer.merge(SqliteClient.layer({ filename }), PersistenceWriteQueue.layer))
      )
    )
    expect(result).toEqual({ during: ["Committed"], after: ["Committed", "Pending"] })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
