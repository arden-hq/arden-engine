import { DateTime, Effect, Option, Schema, Stream } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import type { JournalAppendResult, JournalDelivery, JournalEvent, JournalRecord } from "../types.js"
import { JournalError, journalError, type JournalReadPage } from "./contracts.js"
import {
  PAGE_SIZE,
  decodeJsonData,
  decodeJsonAttributes,
  EventBatchSchema,
  type StreamRow,
  type RecordRow,
  validateCursor,
  validateStreamId,
  freezeRecord,
  readState,
  decodeRow
} from "./records.js"

export const appendInTransaction = Effect.fn("Journal.appendInTransaction")(function* (
  sql: SqlClient.SqlClient,
  streamId: string,
  events: ReadonlyArray<JournalEvent>
): Effect.fn.Return<JournalAppendResult, JournalError> {
  const validStreamId = yield* validateStreamId(streamId, "append")
  const validEvents = yield* Schema.decodeUnknownEffect(EventBatchSchema)(events).pipe(
    Effect.mapError((cause) =>
      journalError("append", "invalid_input", "Invalid journal event batch", cause)
    )
  )
  const snapshots = validEvents.map((event) => ({
    type: event.type,
    dataJson: JSON.stringify(event.data),
    attributesJson: JSON.stringify(event.attributes ?? {}),
    durable: event.durable !== false
  }))
  const current = yield* readState(sql, validStreamId, "append")
  const createdAt = DateTime.formatIso(yield* DateTime.now)
  const records = snapshots.map((event, index) =>
    freezeRecord({
      streamId: validStreamId,
      sequence: current.headSequence + index + 1,
      type: event.type,
      data: decodeJsonData(event.dataJson),
      attributes: decodeJsonAttributes(event.attributesJson),
      durable: event.durable,
      createdAt
    })
  )
  const headSequence = current.headSequence + records.length
  const firstDurable = records.find((record) => record.durable)?.sequence ?? null
  const retainedFromSequence = current.retainedFromSequence ?? firstDurable

  yield* sql`
    INSERT INTO journal_streams (stream_id, head_sequence, retained_from_sequence)
    VALUES (${validStreamId}, ${headSequence}, ${retainedFromSequence})
    ON CONFLICT(stream_id) DO UPDATE SET
      head_sequence = excluded.head_sequence,
      retained_from_sequence = excluded.retained_from_sequence
  `.pipe(
    Effect.mapError((cause) =>
      journalError("append", "storage", "Could not advance journal stream", cause)
    )
  )

  for (const [index, snapshot] of snapshots.entries()) {
    if (!snapshot.durable) continue
    yield* sql`
      INSERT INTO journal_records (
        stream_id, sequence, event_type, data_json, attributes_json, created_at
      ) VALUES (
        ${validStreamId}, ${current.headSequence + index + 1}, ${snapshot.type}, ${snapshot.dataJson},
        ${snapshot.attributesJson}, ${createdAt}
      )
    `.pipe(
      Effect.mapError((cause) =>
        journalError("append", "storage", "Could not persist journal record", cause)
      )
    )
  }

  return Object.freeze({ records: Object.freeze(records), headSequence })
})

export const journalRecordsSql = (sql: SqlClient.SqlClient): Statement.Fragment =>
  sql.literal("journal_records")

export const journalStreamsSql = (sql: SqlClient.SqlClient): Statement.Fragment =>
  sql.literal("journal_streams")

export const journalHeadSequenceSql = (
  sql: SqlClient.SqlClient,
  streamId: string | Statement.Fragment
): Statement.Fragment =>
  sql`(SELECT head_sequence FROM journal_streams WHERE stream_id = ${streamId})`

export const JOURNAL_HEAD_SEQUENCE_SQL =
  "(SELECT head_sequence FROM journal_streams WHERE stream_id = ?)"

export const readHeadSequence = Effect.fn("Journal.readHeadSequence")(function* (
  sql: SqlClient.SqlClient,
  streamId: string
): Effect.fn.Return<number | undefined, JournalError> {
  const rows = yield* sql<Pick<StreamRow, "head_sequence">>`
    SELECT head_sequence FROM journal_streams WHERE stream_id = ${streamId} LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      journalError("read", "storage", "Could not read journal head", cause)
    )
  )
  return rows[0]?.head_sequence
})

export const retainFromInTransaction = Effect.fn("Journal.retainFromInTransaction")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly streamId: string; readonly fromSequence: number }
): Effect.fn.Return<void, JournalError> {
  if (!Number.isSafeInteger(input.fromSequence) || input.fromSequence < 1) {
    return yield* journalError("retain", "invalid_input", "fromSequence must be a positive integer")
  }
  yield* sql`
    DELETE FROM journal_records
    WHERE stream_id = ${input.streamId}
      AND sequence < (
        SELECT MIN(${input.fromSequence}, head_sequence)
        FROM journal_streams WHERE stream_id = ${input.streamId}
      )
  `.pipe(
    Effect.mapError((cause) =>
      journalError("retain", "storage", "Could not delete journal records", cause)
    )
  )
  yield* sql`
    UPDATE journal_streams
    SET retained_from_sequence = MAX(
      COALESCE(retained_from_sequence, 1),
      MIN(${input.fromSequence}, head_sequence)
    )
    WHERE stream_id = ${input.streamId} AND head_sequence > 0
  `.pipe(
    Effect.mapError((cause) =>
      journalError("retain", "storage", "Could not advance journal replay floor", cause)
    )
  )
})

export const deleteStreamInTransaction = Effect.fn("Journal.deleteStreamInTransaction")(function* (
  sql: SqlClient.SqlClient,
  streamId: string
): Effect.fn.Return<void, JournalError> {
  yield* sql`DELETE FROM journal_streams WHERE stream_id = ${streamId}`.pipe(
    Effect.mapError((cause) =>
      journalError("retain", "storage", "Could not delete journal stream", cause)
    )
  )
})

export const truncateBeforeInTransaction = Effect.fn("Journal.truncateBeforeInTransaction")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly streamId: string
      readonly beforeSequence: number
      readonly where: Statement.Fragment
    }
  ): Effect.fn.Return<number, JournalError> {
    const deleted = yield* sql<{ readonly sequence: number }>`
    DELETE FROM journal_records
    WHERE stream_id = ${input.streamId}
      AND sequence < ${input.beforeSequence}
      AND (${input.where})
    RETURNING sequence
  `.pipe(
      Effect.mapError((cause) =>
        journalError("retain", "storage", "Could not delete journal records", cause)
      )
    )
    return deleted.length
  }
)

export const readPageWithSql = Effect.fn("Journal.readPage")(function* (
  sql: SqlClient.SqlClient,
  input: JournalReadPage,
  operation: "read" | "follow"
): Effect.fn.Return<ReadonlyArray<JournalRecord>, JournalError> {
  const streamId = yield* validateStreamId(input.streamId, operation)
  const afterSequence = yield* validateCursor(input.afterSequence, operation, "afterSequence")
  const throughSequence = yield* validateCursor(input.throughSequence, operation, "throughSequence")
  const limit = input.limit ?? PAGE_SIZE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    return yield* journalError(
      operation,
      "invalid_input",
      "limit must be an integer from 1 to 10000"
    )
  }
  const rows = yield* sql<RecordRow>`
    SELECT stream_id, sequence, event_type, data_json, attributes_json, created_at
    FROM journal_records
    WHERE stream_id = ${streamId}
      AND sequence > ${afterSequence}
      AND sequence <= ${throughSequence}
    ORDER BY sequence ASC
    LIMIT ${limit}
  `.pipe(
    Effect.mapError((cause) =>
      journalError(operation, "storage", "Could not read journal records", cause)
    )
  )
  return yield* Effect.forEach(rows, (row) => decodeRow(row, operation))
})

export const durableRange = (
  sql: SqlClient.SqlClient,
  streamId: string,
  afterSequence: number,
  throughSequence: number,
  replayed: boolean
): Stream.Stream<JournalDelivery, JournalError> =>
  Stream.paginate(afterSequence, (cursor) =>
    readPageWithSql(
      sql,
      {
        streamId,
        afterSequence: cursor,
        throughSequence,
        limit: PAGE_SIZE
      },
      "follow"
    ).pipe(
      Effect.map((records) => {
        const next = records.at(-1)?.sequence
        return [
          records.map((record) => ({ kind: "record", record, replayed }) as const),
          next === undefined || records.length < PAGE_SIZE
            ? Option.none<number>()
            : Option.some(next)
        ] as const
      })
    )
  )
