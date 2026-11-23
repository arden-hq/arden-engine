import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteThreadClient } from "@arden-hq/sqlite-thread"
import { Deferred, Effect, Fiber } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { expect, it } from "vitest"

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
        const began = yield* Deferred.make<void>()
        const proceed = yield* Deferred.make<void>()
        const reading = yield* reader
          .withTransaction(
            Effect.gen(function* () {
              const before = count(
                yield* reader<{ readonly n: number }>`SELECT COUNT(*) AS n FROM items`
              )
              yield* Deferred.succeed(began, undefined)
              yield* Deferred.await(proceed)
              const after = count(
                yield* reader<{ readonly n: number }>`SELECT COUNT(*) AS n FROM items`
              )
              return { before, after }
            })
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(began)
        yield* Deferred.succeed(commit, undefined)
        yield* Fiber.join(writing)
        const outside = count(
          yield* reader<{ readonly n: number }>`SELECT COUNT(*) AS n FROM items`.pipe(
            Effect.timeout("1 second")
          )
        )
        yield* Deferred.succeed(proceed, undefined)
        const inside = yield* Fiber.join(reading).pipe(Effect.timeout("1 second"))
        const next = count(yield* reader<{ readonly n: number }>`SELECT COUNT(*) AS n FROM items`)
        return { ...inside, outside, next }
      })
    )
  )

  expect(result).toEqual({ before: 1, after: 1, outside: 2, next: 2 })
})
