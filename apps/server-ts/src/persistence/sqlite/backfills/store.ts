import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { AnyBackfill } from "./backfill.js"
import { BackfillStoreError } from "../../backfills/store.js"
import type { PersistenceDeps } from "../deps.js"
import { SessionLifecycleEvents } from "../../sessions/events.js"
import { runIsActive } from "../background-pause.js"

export interface BackfillState {
  readonly name: string
  readonly converted: number
  readonly finished: boolean
}

interface BackfillRow {
  readonly name: string
  readonly cursor: string | null
  readonly converted: number
  readonly finished_at: string | null
}

const stateOf = (row: BackfillRow): BackfillState => ({
  name: row.name,
  converted: row.converted,
  finished: row.finished_at !== null
})

const failed = (message: string) => (cause: unknown) => new BackfillStoreError({ message, cause })

export const makeBackfillChunks = ({
  writer,
  reader,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "reader" | "sessionEvents">) => {
  const sql = writer.sql
  const runChunk = Effect.fn("BackfillStore.runChunk")(function* (
    backfill: AnyBackfill,
    limit: number
  ) {
    for (;;) {
      const before = (yield* reader<BackfillRow>`
        SELECT name, cursor, converted, finished_at FROM data_backfills
        WHERE name = ${backfill.name}
      `.pipe(Effect.mapError(failed(`Could not read backfill ${backfill.name}`))))[0]
      const prepared =
        backfill.prepare === undefined || before?.finished_at != null
          ? undefined
          : yield* backfill
              .prepare({
                cursor: before?.cursor ?? undefined,
                limit,
                reader
              })
              .pipe(Effect.mapError(failed(`Could not prepare backfill ${backfill.name}`)))
      const attempted = yield* writer
        .transact(
          Effect.gen(function* () {
            const rows = yield* sql<BackfillRow>`
          SELECT name, cursor, converted, finished_at FROM data_backfills
          WHERE name = ${backfill.name}`
            const row = rows[0]
            const previousCursor = row?.cursor ?? undefined
            if (previousCursor !== (before?.cursor ?? undefined)) return { kind: "stale" as const }
            if (row?.finished_at != null)
              return {
                kind: "done" as const,
                value: { state: stateOf(row), previousCursor, cursor: previousCursor }
              }
            const chunkEffect =
              backfill.prepare === undefined
                ? backfill.chunk({ cursor: previousCursor, limit })
                : prepared
            if (chunkEffect === undefined) return { kind: "stale" as const }
            const chunk = yield* chunkEffect.pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.provideService(SessionLifecycleEvents, sessionEvents)
            )
            const now = DateTime.formatIso(yield* DateTime.now)
            const converted = (row?.converted ?? 0) + chunk.converted
            const finishedAt = chunk.next === undefined ? now : null
            yield* sql`
          INSERT INTO data_backfills (name, cursor, converted, started_at, updated_at, finished_at)
          VALUES (${backfill.name}, ${chunk.next ?? null}, ${converted}, ${now}, ${now}, ${finishedAt})
          ON CONFLICT(name) DO UPDATE SET
            cursor = excluded.cursor,
            converted = excluded.converted,
            updated_at = excluded.updated_at,
            finished_at = excluded.finished_at`
            return {
              kind: "done" as const,
              value: {
                state: { name: backfill.name, converted, finished: finishedAt !== null },
                previousCursor,
                cursor: chunk.next
              }
            }
          })
        )
        .pipe(Effect.mapError(failed(`Could not run a chunk of backfill ${backfill.name}`)))
      if (attempted.kind === "done") return attempted.value
    }
  })
  return {
    states: () =>
      reader<BackfillRow>`
        SELECT name, cursor, converted, finished_at FROM data_backfills ORDER BY name`.pipe(
        Effect.map((rows) => rows.map(stateOf)),
        Effect.mapError(failed("Could not read the backfills"))
      ),
    runChunk,
    remaining: (backfill: AnyBackfill) =>
      backfill.remaining.pipe(
        Effect.provideService(SqlClient.SqlClient, reader),
        Effect.mapError(failed(`Could not count what backfill ${backfill.name} has left`))
      ),
    runActive: () =>
      runIsActive(reader).pipe(Effect.mapError(failed("Could not check for active runs")))
  }
}
