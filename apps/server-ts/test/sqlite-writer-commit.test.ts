import { Deferred, Effect, Fiber } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { sqliteWriterLayer } from "../src/persistence/sqlite/writer-client.js"

it.each(["begin", "commit"] as const)(
  "a waiting %s lets the lock owner run without replaying the body",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "arden-writer-lock-"))
    const filename = join(directory, "main.db")
    const blocker = new DatabaseSync(filename)
    blocker.exec("CREATE TABLE t (v TEXT)")
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const attempted = yield* Deferred.make<void>()
          let bodies = 0
          if (phase === "begin") blocker.exec("BEGIN IMMEDIATE")
          else {
            blocker.exec("BEGIN")
            blocker.prepare("SELECT * FROM t").all()
          }
          const write = yield* Effect.gen(function* () {
            if (phase === "begin") yield* Deferred.succeed(attempted, undefined)
            yield* sql.withTransaction(
              Effect.gen(function* () {
                bodies += 1
                yield* sql`INSERT INTO t (v) VALUES ('kept')`
                if (phase === "commit") yield* Deferred.succeed(attempted, undefined)
              })
            )
          }).pipe(Effect.forkChild)
          yield* Deferred.await(attempted)
          yield* Effect.yieldNow
          blocker.exec("COMMIT")
          yield* Fiber.join(write)
          const rows = yield* sql<{ readonly v: string }>`SELECT v FROM t`
          return { bodies, rows }
        }).pipe(
          Effect.provide(sqliteWriterLayer({ filename, disableWAL: true, busyTimeout: 100 })),
          Effect.scoped
        )
      )
      expect(result).toEqual({ bodies: 1, rows: [{ v: "kept" }] })
    } finally {
      blocker.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it("a COMMIT that fails on a locked attached database rolls back and leaves the writer usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-writer-commit-"))
  const main = join(directory, "main.db")
  const side = join(directory, "side.sqlite")
  const setup = new DatabaseSync(side)
  setup.exec("CREATE TABLE t (v TEXT)")
  setup.close()
  const reader = new DatabaseSync(side)
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe("ATTACH DATABASE ? AS side", [side])
        const write = (value: string) =>
          sql.withTransaction(sql`INSERT INTO side.t (v) VALUES (${value})`)
        reader.exec("BEGIN")
        reader.prepare("SELECT count(*) FROM t").all()
        const locked = yield* Effect.exit(write("lost"))
        reader.exec("COMMIT")
        yield* write("kept")
        const rows = yield* sql<{ readonly v: string }>`SELECT v FROM side.t ORDER BY v`
        return { locked: locked._tag, rows: rows.map((row) => row.v) }
      }).pipe(Effect.provide(sqliteWriterLayer({ filename: main, busyTimeout: 50 })), Effect.scoped)
    )
    expect(result).toEqual({ locked: "Failure", rows: ["kept"] })
  } finally {
    reader.close()
    await rm(directory, { recursive: true, force: true })
  }
})
