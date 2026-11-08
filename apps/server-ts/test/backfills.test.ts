import { makeChatEventStore } from "../src/persistence/sqlite/events.js"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { Backfill } from "../src/persistence/sqlite/backfills/backfill.js"
import {
  makeBackfillChunks,
  type BackfillState
} from "../src/persistence/sqlite/backfills/store.js"
import { makeWriter } from "../src/persistence/sqlite/deps.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { dataBackfillsSchemaSection } from "../src/persistence/schema/sections/data-backfills.js"
import { makeSessionLifecycleEvents } from "../src/persistence/sqlite/lifecycle-events.js"
import { makeJournalRuntime } from "@arden-hq/journal/effect"

const upperCase = (
  calls: Array<string | undefined>,
  failOnCalls: ReadonlySet<number> = new Set()
): Backfill => ({
  name: "upper_case",
  chunk: ({ cursor, limit }) =>
    Effect.gen(function* () {
      calls.push(cursor)
      const sql = yield* SqlClient.SqlClient
      const after = cursor === undefined ? 0 : Number(cursor)
      const rows = yield* sql<{ readonly id: number }>`
        SELECT id FROM items WHERE id > ${after} ORDER BY id LIMIT ${limit}`
      const changed = yield* sql<{ readonly id: number }>`
        UPDATE items SET upper = upper(text)
        WHERE id > ${after} AND id <= ${rows.at(-1)?.id ?? after} AND upper IS NULL
        RETURNING id`
      if (failOnCalls.has(calls.length)) return yield* Effect.die(new Error("power cut"))
      const last = rows.at(-1)
      return {
        converted: changed.length,
        next: rows.length < limit || last === undefined ? undefined : String(last.id)
      }
    }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM items WHERE upper IS NULL`
    return rows[0]?.n ?? 0
  })
})

const withStore = <A, E>(
  rows: number,
  body: (input: {
    readonly store: ReturnType<typeof makeBackfillChunks>
    readonly sql: SqlClient.SqlClient
  }) => Effect.Effect<A, E>
) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const queue = yield* PersistenceWriteQueue
        for (const statement of dataBackfillsSchemaSection.statements) yield* sql.unsafe(statement)
        yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL, upper TEXT)`
        yield* sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
          INSERT INTO items (id, text) SELECT i, 'row ' || i FROM n`
        const writer = makeWriter({ sql, reader: sql, queue })
        const journal = yield* makeJournalRuntime(sql, { initialize: false })
        const store = makeBackfillChunks({
          writer,
          reader: sql,
          sessionEvents: makeSessionLifecycleEvents({
            writer,
            journal,
            chatEvents: makeChatEventStore({ writer, journal })
          })
        })
        return yield* body({ store, sql })
      })
    ).pipe(
      Effect.provide(
        Layer.merge(SqliteClient.layer({ filename: ":memory:" }), PersistenceWriteQueue.layer)
      )
    )
  )

const drainBackfill = (
  backfill: Backfill,
  { store }: { readonly store: ReturnType<typeof makeBackfillChunks> }
) =>
  Effect.gen(function* () {
    for (;;) {
      const step = yield* store.runChunk(backfill, 200)
      if (step.state.finished) return step.state
    }
  })

describe("data backfills", () => {
  it("converges to every row converted once, whatever rows a writer converted first and wherever chunks crash", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 650 }),
        fc.integer({ min: 2, max: 7 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 6 }), { maxLength: 3 }),
        async (rows, newEvery, crashes) => {
          const calls: Array<string | undefined> = []
          const backfill = upperCase(calls, new Set(crashes))
          const exit = await withStore(rows, ({ store, sql }) =>
            Effect.gen(function* () {
              yield* sql`UPDATE items SET upper = 'NEW' WHERE id % ${newEvery} = 0`
              let state: BackfillState | undefined
              for (let start = 0; start <= crashes.length && state === undefined; start += 1) {
                const run = yield* drainBackfill(backfill, { store }).pipe(Effect.exit)
                if (Exit.isSuccess(run)) state = run.value
              }
              const callsBefore = calls.length
              const again = yield* drainBackfill(backfill, { store })
              const wrong = yield* sql<{ readonly n: number }>`
                SELECT count(*) AS n FROM items
                WHERE upper IS NOT (CASE WHEN id % ${newEvery} = 0 THEN 'NEW' ELSE upper(text) END)`
              return { state, again, rerunCalls: calls.length - callsBefore, wrong: wrong[0]?.n }
            })
          )
          const converted = rows - Math.floor(rows / newEvery)
          const finished = { name: "upper_case", converted, finished: true }
          expect(exit).toEqual(
            Exit.succeed({ state: finished, again: finished, rerunCalls: 0, wrong: 0 })
          )
        }
      ),
      { numRuns: 15 }
    )
  })
})
