import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Cause, Effect, Exit } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { expect, it } from "vitest"

it("preserves failed BEGIN and releases the connection for the next transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-sql-begin-"))
  const filename = join(directory, "test.db")
  const writer = new DatabaseSync(filename)
  try {
    writer.exec("CREATE TABLE records (value INTEGER); BEGIN IMMEDIATE")
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const failed = yield* Effect.exit(sql.withTransaction(sql`INSERT INTO records VALUES (1)`))
        expect(Exit.isFailure(failed)).toBe(true)
        if (Exit.isFailure(failed)) {
          expect(Cause.pretty(failed.cause)).toMatch(/locked|busy/i)
          expect(Cause.pretty(failed.cause)).not.toContain("cannot rollback")
        }
        writer.exec("ROLLBACK")
        yield* sql.withTransaction(sql`INSERT INTO records VALUES (2)`)
        expect(yield* sql`SELECT value FROM records`).toEqual([{ value: 2 }])
        const bodyFailure = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO records VALUES (3)`
              return yield* Effect.fail("body failed")
            })
          )
        )
        expect(Exit.isFailure(bodyFailure)).toBe(true)
        expect(yield* sql`SELECT value FROM records`).toEqual([{ value: 2 }])
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO records VALUES (4)`
            const nested = yield* Effect.exit(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO records VALUES (5)`
                  return yield* Effect.fail("nested body failed")
                })
              )
            )
            expect(Exit.isFailure(nested)).toBe(true)
            yield* sql`INSERT INTO records VALUES (6)`
          })
        )
        expect(yield* sql`SELECT value FROM records ORDER BY value`).toEqual([
          { value: 2 },
          { value: 4 },
          { value: 6 }
        ])
      }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true, busyTimeout: 0 })))
    )
  } finally {
    writer.close()
    await rm(directory, { recursive: true, force: true })
  }
})
