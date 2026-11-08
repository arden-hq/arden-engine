import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { PersistenceDeps } from "./deps.js"
import { pauseBetweenBatches, runIsActive } from "./background-pause.js"
import { journalRunIdSql } from "./journal-run-boundary.js"

/** Rows read, and at most deleted, per write transaction. */
const WALK_BATCH_ROWS = 2_000

export interface WalkRow {
  readonly rowid: number
  readonly stream_id: string
  readonly sequence: number
  readonly event_type: string
  readonly run_id: string | null
  /** 1 while the row was created before the cutoff. */
  readonly old: number
}

export interface WalkDecision {
  /** Rows to delete. */
  readonly remove: ReadonlyArray<WalkRow>
  /** Runs in the same write after the delete, given the rows it removed. */
  readonly after: (removed: ReadonlyArray<WalkRow>) => Effect.Effect<void, unknown>
}

interface CursorRow {
  readonly after_rowid: number
  readonly stream_id: string | null
  readonly sequence: number | null
}

/** The pause between batches of background journal work. */
export const batchPause = (reader: SqlClient.SqlClient) =>
  runIsActive(reader).pipe(Effect.flatMap(pauseBetweenBatches))

/** The saved position of a walk. Rowids only change in a VACUUM (Arden runs
 * one only when it creates an empty database), but the cursor also remembers
 * the row's (stream, sequence): if that row now sits at another rowid, the walk
 * follows the row; if the rowid holds a different row and the saved row is
 * gone (the usual case: the row was deleted), it steps back to the next lower rowid. */
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

/** Walk `journal_records` in insertion order behind `cutoff`, from the walk's
 * saved position. It reads rows with `rowid > cursor`, stops at the first row
 * created at or after the cutoff (or that `stop` names), and lets `decide`
 * choose which of up to 2000 rows to delete, in one write transaction that also
 * saves the position. Work per tick is the rows that crossed the cutoff since
 * the last one, however large the journal is. Returns the rows deleted. */
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
            created_at < ${cutoff} AS old
          FROM journal_records WHERE rowid > ${cursor} ORDER BY rowid LIMIT ${WALK_BATCH_ROWS}
        `
        const end = page.findIndex((row) => row.old !== 1 || input.stop?.(row) === true)
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
          done: end !== -1 || page.length < WALK_BATCH_ROWS,
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
