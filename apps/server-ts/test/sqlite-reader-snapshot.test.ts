import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteThreadClient } from "@arden-hq/sqlite-thread"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { expect, it } from "vitest"

import { makeWriter, READER_CONNECTIONS } from "../src/persistence/sqlite/deps.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"

const inTempFile = async <A, E>(
  body: (filename: string) => Effect.Effect<A, E, Reactivity.Reactivity>
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-reader-snapshot-"))
  try {
    return await Effect.runPromise(
      body(join(directory, "arden.db")).pipe(Effect.provide(Reactivity.layer))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const count = (rows: ReadonlyArray<{ readonly n: number }>) => rows[0]?.n

it("a reader transaction keeps one commit while the writer holds and commits a transaction", async () => {
  const result = await inTempFile((filename) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* makeSqliteThreadClient({ filename })
        yield* sql`CREATE TABLE items (value INTEGER)`
        yield* sql`INSERT INTO items VALUES (1)`
        const reader = yield* makeSqliteThreadClient({ filename, readonly: true, connections: 2 })
        const held = yield* Deferred.make<void>()
        const commit = yield* Deferred.make<void>()
        const writing = yield* sql
          .withTransaction(
            sql`INSERT INTO items VALUES (2)`.pipe(
              Effect.andThen(Deferred.succeed(held, undefined)),
              Effect.andThen(Deferred.await(commit))
            )
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(held)
        const inside = yield* reader
          .withTransaction(
            Effect.gen(function* () {
              const before = count(
                yield* reader<{ readonly n: number }>`SELECT COUNT(*) AS n FROM items`
              )
              yield* Deferred.succeed(commit, undefined)
              yield* Fiber.join(writing)
              const after = count(
                yield* reader<{ readonly n: number }>`SELECT COUNT(*) AS n FROM items`
              )
              return { before, after }
            })
          )
          .pipe(Effect.timeout("1 second"))
        const next = count(yield* reader<{ readonly n: number }>`SELECT COUNT(*) AS n FROM items`)
        return { ...inside, next }
      })
    )
  )

  expect(result).toEqual({ before: 1, after: 1, next: 2 })
})

it("runs at most half the reader connections as snapshots and leaves the rest to reads", async () => {
  const result = await inTempFile((filename) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* makeSqliteThreadClient({ filename })
        yield* sql`CREATE TABLE items (value INTEGER)`
        const reader = yield* makeSqliteThreadClient({
          filename,
          readonly: true,
          connections: READER_CONNECTIONS
        })
        const writer = makeWriter({ sql, reader, queue: yield* PersistenceWriteQueue })
        const entered = yield* Ref.make(0)
        const gate = yield* Deferred.make<void>()
        const snapshots = yield* Effect.forEach(
          [1, 2, 3],
          () =>
            writer
              .snapshot(
                Effect.gen(function* () {
                  yield* reader`SELECT COUNT(*) AS n FROM items`
                  // A nested snapshot joins the transaction instead of taking a permit.
                  yield* writer.snapshot(reader`SELECT COUNT(*) AS n FROM items`)
                  yield* Ref.update(entered, (n) => n + 1)
                  yield* Deferred.await(gate)
                })
              )
              .pipe(Effect.forkScoped),
          { concurrency: "unbounded" }
        )
        yield* Effect.sleep("100 millis")
        const whileHeld = yield* Ref.get(entered)
        const read = count(
          yield* reader<{ readonly n: number }>`SELECT COUNT(*) AS n FROM items`.pipe(
            Effect.timeout("1 second")
          )
        )
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.joinAll(snapshots).pipe(Effect.timeout("1 second"))
        return { whileHeld, read, finished: yield* Ref.get(entered) }
      })
    ).pipe(Effect.provide(PersistenceWriteQueue.layer))
  )

  expect(result).toEqual({ whileHeld: READER_CONNECTIONS / 2, read: 0, finished: 3 })
})
