import { stat } from "node:fs/promises"
import { Deferred, Duration, Effect, Fiber } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import { StorageSessionStore } from "../src/persistence/storage/session-store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import {
  afterPass,
  freeSpacePolicy,
  makeFreeSpaceWorker,
  passContinues,
  planPages,
  startsDrain,
  type DrainState,
  type FreeSpacePolicy,
  type PassResult
} from "../src/storage/free-space.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

describe("free-space planning", () => {
  const plan = planPages(freeSpacePolicy, 4_096)

  it("runs at most the pass's batches, and none once its time is spent", () => {
    const batches = Array.from({ length: 12 }, (_, batches) => batches).filter((batches) =>
      passContinues({ batches, elapsedMillis: 0, plan })
    )
    expect(batches).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(passContinues({ batches: 1, elapsedMillis: 249, plan })).toBe(true)
    expect(passContinues({ batches: 1, elapsedMillis: 250, plan })).toBe(false)
  })

  it("starts a scheduled drain at the start gate and a requested one above the reserve", () => {
    const cases = [
      { free: plan.startPages - 1, trigger: "schedule" },
      { free: plan.startPages, trigger: "schedule" },
      { free: plan.reservePages, trigger: "requested" },
      { free: plan.reservePages + 1, trigger: "requested" }
    ] as const
    expect(cases.map(({ free, trigger }) => startsDrain({ free, plan, trigger }))).toEqual([
      false,
      true,
      false,
      true
    ])
  })

  it("backs off while it cannot get in, and returns to the active pace after progress", () => {
    const steps = (state: DrainState, passes: ReadonlyArray<PassResult>) =>
      passes.reduce<{ state: DrainState; seen: Array<[number, string]> }>(
        (acc, pass) => {
          const next = afterPass(acc.state, pass)
          return {
            state: next.state,
            seen: [...acc.seen, [Duration.toMillis(next.delay), next.checkpoint]]
          }
        },
        { state, seen: [] }
      )
    const stalled: PassResult = { end: "yielded", released: 0 }
    const { seen, state } = steps({ kind: "idle" }, [
      ...Array.from({ length: 9 }, () => stalled),
      { end: "yielded", released: 10 },
      stalled,
      { end: "budget", released: 2_048 },
      { end: "done", released: 5 }
    ])
    expect(seen).toEqual([
      [500, "none"],
      [1_000, "none"],
      [2_000, "none"],
      [4_000, "none"],
      [8_000, "none"],
      [16_000, "none"],
      [32_000, "none"],
      [60_000, "none"],
      [60_000, "none"],
      [2_000, "passive"],
      [500, "none"],
      [2_000, "passive"],
      [60_000, "truncate"]
    ])
    expect(state).toEqual({ kind: "idle" })
  })
})

const PAGE = 4_096
const testPolicy: FreeSpacePolicy = {
  startBytes: 0,
  reserveBytes: 100 * PAGE,
  batchBytes: 64 * PAGE,
  passBatches: 8,
  passMillis: 60_000
}

// Fills about `pages` pages with rows and deletes them, leaving them free.
const leaveFreePages = (sql: SqlClient.SqlClient, pages: number) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE filler (body BLOB NOT NULL)`
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${pages})
      INSERT INTO filler (body) SELECT randomblob(3900) FROM n`
    yield* sql`DROP TABLE filler`
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`
  })

const freelist = (sql: SqlClient.SqlClient) =>
  sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.die("no freelist_count")
        : Effect.succeed(rows[0].freelist_count)
    )
  )

const fileBytes = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string; readonly file: string }>`PRAGMA database_list`.pipe(
    Effect.flatMap((rows) => {
      const main = rows.find((row) => row.name === "main")
      return main === undefined
        ? Effect.die("no main database")
        : Effect.promise(() => stat(main.file)).pipe(Effect.map((info) => info.size))
    })
  )

it("drains free pages down to the reserve in batches and shrinks the file", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* StorageSessionStore
      yield* leaveFreePages(sql, 2_000)
      const before = { free: yield* freelist(sql), bytes: yield* fileBytes(sql) }
      const worker = yield* makeFreeSpaceWorker(store, { policy: testPolicy })
      const passes = yield* Effect.gen(function* () {
        const results: Array<PassResult> = []
        for (;;) {
          const pass = yield* worker.drainNow()
          results.push(pass)
          if (pass.end === "done") return results
        }
      })
      const after = { free: yield* freelist(sql), bytes: yield* fileBytes(sql) }
      return { before, passes, after }
    })
  )
  const released = outcome.before.free - 100
  expect(outcome.before.free).toBeGreaterThan(1_900)
  expect(outcome.passes.slice(0, -1)).toEqual(
    Array.from({ length: Math.floor(released / 512) }, () => ({ end: "budget", released: 512 }))
  )
  expect(outcome.passes.at(-1)).toEqual({ end: "done", released: released % 512 })
  expect(outcome.after.free).toBe(100)
  // Pointer-map pages that tracked the released pages go too.
  expect(outcome.before.bytes - outcome.after.bytes).toBeGreaterThanOrEqual(released * PAGE)
})

it("gives way before releasing anything while another write waits", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* StorageSessionStore
      const writes = yield* PersistenceWriteQueue
      yield* leaveFreePages(sql, 500)
      const worker = yield* makeFreeSpaceWorker(store, { policy: testPolicy })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holding = yield* writes
        .run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const waiting = yield* writes.run(Effect.void).pipe(Effect.forkChild)
      while ((yield* writes.waiting) === 0) yield* Effect.yieldNow
      const free = yield* freelist(sql)
      const blocked = yield* worker.drainNow()
      const untouched = (yield* freelist(sql)) === free
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holding)
      yield* Fiber.join(waiting)
      const resumed = yield* worker.drainNow()
      return { blocked, untouched, resumed: resumed.released > 0 }
    })
  )
  expect(outcome).toEqual({
    blocked: { end: "yielded", released: 0 },
    untouched: true,
    resumed: true
  })
})
