import { journalRecordsSql, truncateBeforeInTransaction } from "@arden-hq/journal/effect"
import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { PersistenceDeps } from "./deps.js"

/** Sequences scanned per query, so no read walks a whole large stream. */
const JOURNAL_SCAN_WINDOW = 10_000

/** Read a stream in sequence windows, passing each page to `onPage`. `columns`
 * must include `sequence`; `where` filters the rows. `read` lets a caller run
 * each query in a lane of its own (the writer's, for example). */
export const scanJournalWindows = Effect.fn("Journal.scanWindows")(function* <Row, E>(input: {
  readonly sql: SqlClient.SqlClient
  readonly streamId: string
  readonly afterSequence: number
  readonly throughSequence: number
  readonly columns: Statement.Fragment
  readonly where: Statement.Fragment
  readonly window?: number
  readonly read?: <A, F>(effect: Effect.Effect<A, F>) => Effect.Effect<A, F>
  readonly onPage: (page: ReadonlyArray<Row>) => Effect.Effect<void, E>
}) {
  const { sql } = input
  const window = input.window ?? JOURNAL_SCAN_WINDOW
  const read = input.read ?? ((effect) => effect)
  for (let after = input.afterSequence; after < input.throughSequence; after += window) {
    const page = yield* read(
      sql<Row & object>`
        SELECT ${input.columns} FROM ${journalRecordsSql(sql)}
        WHERE stream_id = ${input.streamId}
          AND sequence > ${after} AND sequence <= ${after + window}
          AND (${input.where})
        ORDER BY sequence
      `
    )
    yield* input.onPage(page)
  }
})

/** Delete the given sequences below `beforeSequence` in short write
 * transactions, `batchSize` at a time, pausing between them. `where` is
 * applied again inside each write. The replay floor does not move. */
export const deleteJournalSequences = Effect.fn("Journal.deleteSequences")(function* (input: {
  readonly writer: PersistenceDeps["writer"]
  readonly streamId: string
  readonly beforeSequence: number
  readonly sequences: ReadonlyArray<number>
  readonly batchSize: number
  readonly where: Statement.Fragment
  readonly pause?: Effect.Effect<void, unknown>
}) {
  const { writer } = input
  let deleted = 0
  for (let start = 0; start < input.sequences.length; start += input.batchSize) {
    const batch = input.sequences.slice(start, start + input.batchSize)
    deleted += yield* writer.transact(
      truncateBeforeInTransaction(writer.sql, {
        streamId: input.streamId,
        beforeSequence: input.beforeSequence,
        where: writer.sql`sequence IN ${writer.sql.in(batch)} AND (${input.where})`
      })
    )
    if (input.pause !== undefined) yield* input.pause
  }
  return deleted
})
