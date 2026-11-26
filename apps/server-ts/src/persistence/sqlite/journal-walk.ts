import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { PersistenceDeps } from "./deps.js"
import { pauseBetweenBatches, runIsActive } from "./background-pause.js"
import { journalRunIdSql } from "./journal-run-boundary.js"
import type { SqlError } from "effect/unstable/sql/SqlError"

const WALK_ROWS_PER_WRITE = 2_000

export interface WalkRow {
  readonly rowid: number
  readonly stream_id: string
  readonly sequence: number
  readonly event_type: string
  readonly run_id: string | null
  readonly before_cutoff: number
}

export interface WalkDecision {
  readonly remove: ReadonlyArray<WalkRow>
  readonly after: (removed: ReadonlyArray<WalkRow>) => Effect.Effect<void, unknown>
}

interface CursorRow {
  readonly after_rowid: number
  readonly stream_id: string | null
  readonly sequence: number | null
}

export const batchPause = (reader: SqlClient.SqlClient): Effect.Effect<void, SqlError, never> =>
  runIsActive(reader).pipe(Effect.flatMap(pauseBetweenBatches))

const resolveCursor = Effect.fn("Journal.resolveWalkCursor")(function* (
  sql: SqlClient.SqlClient,
  name: string
) {
  const saved = (yield* sql<CursorRow>`
    SELECT after_rowid, stream_id, sequence FROM journal_retention_cursors WHERE name = ${name}
  `)[0]
  if (saved === undefined) return 0
  if (saved.stream_id === null || saved.sequence === null) return saved.after_rowid
  const at = (yield* sql<{ readonly stream_id: string; readonly sequence: number }>`
    SELECT stream_id, sequence FROM journal_records WHERE rowid = ${saved.after_rowid}
  `)[0]
  if (at?.stream_id === saved.stream_id && at.sequence === saved.sequence) return saved.after_rowid
  const moved = (yield* sql<{ readonly rowid: number }>`
    SELECT rowid FROM journal_records
    WHERE stream_id = ${saved.stream_id} AND sequence = ${saved.sequence}
  `)[0]
  if (moved !== undefined) return moved.rowid
  return (
    (yield* sql<{ readonly rowid: number | null }>`
    SELECT MAX(rowid) AS rowid FROM journal_records WHERE rowid < ${saved.after_rowid}
  `)[0]?.rowid ?? 0
  )
})

export const walkJournal = Effect.fn("Journal.walk")(function* (input: {
  readonly writer: PersistenceDeps["writer"]
  readonly name: string
  readonly cutoff: string
  readonly stop?: (row: WalkRow) => boolean
  readonly decide: (
    sql: SqlClient.SqlClient,
    rows: ReadonlyArray<WalkRow>
  ) => Effect.Effect<WalkDecision, unknown>
}) {
  const { writer, name, cutoff } = input
  const { sql } = writer
  let cursor = yield* resolveCursor(writer.reader, name)
  let deleted = 0
  for (;;) {
    const step = yield* writer.transact(
      Effect.gen(function* () {
        const page = yield* sql<WalkRow>`
          SELECT rowid, stream_id, sequence, event_type, ${journalRunIdSql(sql)} AS run_id,
            created_at < ${cutoff} AS before_cutoff
          FROM journal_records WHERE rowid > ${cursor} ORDER BY rowid LIMIT ${WALK_ROWS_PER_WRITE}
        `
        const end = page.findIndex((row) => row.before_cutoff !== 1 || input.stop?.(row) === true)
        const rows = end === -1 ? page : page.slice(0, end)
        const last = rows.at(-1)
        if (last === undefined) return { done: true, deleted: 0, cursor }
        const decision = yield* input.decide(sql, rows)
        const gone =
          decision.remove.length === 0
            ? new Set<number>()
            : new Set(
                (yield* sql<{ readonly rowid: number }>`
                  DELETE FROM journal_records
                  WHERE rowid IN ${sql.in(decision.remove.map((row) => row.rowid))}
                  RETURNING rowid
                `).map((row) => row.rowid)
              )
        yield* decision.after(decision.remove.filter((row) => gone.has(row.rowid)))
        yield* sql`
          INSERT INTO journal_retention_cursors (name, after_rowid, stream_id, sequence)
          VALUES (${name}, ${last.rowid}, ${last.stream_id}, ${last.sequence})
          ON CONFLICT(name) DO UPDATE SET after_rowid = excluded.after_rowid,
            stream_id = excluded.stream_id, sequence = excluded.sequence
        `
        return {
          done: end !== -1 || page.length < WALK_ROWS_PER_WRITE,
          deleted: gone.size,
          cursor: last.rowid
        }
      })
    )
    deleted += step.deleted
    cursor = step.cursor
    if (step.done) return deleted
    yield* batchPause(writer.reader)
  }
})
