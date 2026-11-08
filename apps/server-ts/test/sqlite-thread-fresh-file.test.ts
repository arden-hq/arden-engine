import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteThreadClient } from "@arden-hq/sqlite-thread"
import { Effect } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { expect, it } from "vitest"

it("connections that open the same new file at once all start in WAL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-sqlite-thread-"))
  try {
    for (let round = 0; round < 10; round++) {
      const filename = join(directory, `round-${round}.db`)
      const modes = await Effect.runPromise(
        Effect.scoped(
          Effect.forEach(
            [0, 1, 2, 3],
            () =>
              Effect.gen(function* () {
                const sql = yield* makeSqliteThreadClient({ filename, busyTimeout: 0 })
                const rows = yield* sql.unsafe<{ readonly journal_mode: unknown }>(
                  "PRAGMA journal_mode"
                )
                return rows[0]?.journal_mode
              }),
            { concurrency: "unbounded" }
          )
        ).pipe(Effect.provide(Reactivity.layer))
      )
      expect(modes).toEqual(["wal", "wal", "wal", "wal"])
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
