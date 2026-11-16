import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import {
  MemoryCaptureBatchIdentitySchema,
  type MemoryCaptureBatchIdentity,
  type MemoryCaptureMove,
  type MemoryCapturePosition,
  type MemoryCaptureWork
} from "../memory/store.js"
import { userChatSql } from "./chat-ownership.js"
import { activeRunStatusList } from "./status-sets.js"

const IdentityJson = Schema.fromJsonString(MemoryCaptureBatchIdentitySchema)

interface PositionColumns {
  readonly read_seq: number
  readonly read_offset: number | null
}

const columnsOf = (position: MemoryCapturePosition): PositionColumns => {
  switch (position._tag) {
    case "Beginning":
      return { read_seq: -1, read_offset: null }
    case "AfterSequence":
      return { read_seq: position.sequence, read_offset: null }
    case "AtPosition":
      return { read_seq: position.progress.sequence, read_offset: position.progress.offset }
  }
}

const positionOf = (columns: PositionColumns): MemoryCapturePosition => {
  if (columns.read_seq < 0) return { _tag: "Beginning" }
  if (columns.read_offset === null) return { _tag: "AfterSequence", sequence: columns.read_seq }
  return {
    _tag: "AtPosition",
    progress: { sequence: columns.read_seq, offset: columns.read_offset }
  }
}

const encodeIdentity = (identity: MemoryCaptureBatchIdentity) =>
  Schema.encodeEffect(IdentityJson)(identity)

interface WorkRow extends PositionColumns {
  readonly session_id: string
  readonly through_seq: number
  readonly prepared_json: string | null
}

/**
 * Unread ranges of owner chats, archived ones included, that have a prepared batch to finish or
 * messages past where reading stopped: the open range of a chat while no run is active in it,
 * and, when `older`, closed ranges not resting. Prepared batches first, then open ranges, then
 * the range whose first unread message is oldest.
 */
export const listCaptureWork = Effect.fn("MemoryCapturePositions.listWork")(function* (
  sql: SqlClient.SqlClient,
  limit: number,
  older: boolean
) {
  const restedSince = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }))
  const rows = yield* sql<WorkRow>`
    WITH ranges AS (
      SELECT unread.session_id,
             unread.read_seq,
             unread.read_offset,
             unread.prepared_json,
             unread.through_seq IS NULL AS open,
             CASE WHEN unread.prepared_cut_seq IS NULL
               THEN COALESCE(unread.through_seq, (SELECT MAX(seq) FROM session_messages AS message
                 WHERE message.session_id = unread.session_id))
               ELSE unread.prepared_cut_seq - 1 END AS through_seq,
             EXISTS (SELECT 1 FROM chat_runs AS run
               WHERE run.session_id = unread.session_id
                 AND run.status IN ${activeRunStatusList}) AS running
      FROM memory_capture_unread AS unread
      JOIN sessions AS session ON session.session_id = unread.session_id
      WHERE ${userChatSql("session")}
        AND (unread.through_seq IS NULL OR (${older ? 1 : 0} = 1
          AND (unread.tried_at IS NULL OR unread.tried_at <= ${restedSince})))
    )
    SELECT session_id, read_seq, read_offset, prepared_json, through_seq
    FROM ranges
    WHERE through_seq IS NOT NULL
      AND (prepared_json IS NOT NULL
        OR ((open = 0 OR running = 0) AND (through_seq > read_seq OR read_offset IS NOT NULL)))
    ORDER BY prepared_json IS NULL, open = 0,
      (SELECT created_at FROM session_messages AS message
        WHERE message.session_id = ranges.session_id
          AND message.seq > ranges.read_seq - (ranges.read_offset IS NOT NULL)
        ORDER BY message.seq LIMIT 1),
      session_id
    LIMIT ${limit}
  `
  return yield* Effect.forEach(
    rows,
    Effect.fn("MemoryCapturePositions.workRow")(function* (row) {
      return {
        sessionId: row.session_id,
        position: positionOf(row),
        throughSequence: row.through_seq,
        prepared:
          row.prepared_json === null
            ? undefined
            : yield* Schema.decodeUnknownEffect(IdentityJson)(row.prepared_json)
      } satisfies MemoryCaptureWork
    })
  )
})

interface StoredRange {
  readonly range_id: number
  readonly prepared_json: string | null
  readonly prepared_cut_seq: number | null
  readonly end_holds: number
}

/**
 * The unread range that stopped at `batch`'s start, and where it goes when the batch is read, or
 * undefined when the chat moved on: no range stops there, another batch is prepared, or the
 * message at its end is gone. When a revert removed later messages of the prepared batch, it
 * ends before the first one removed: the last message it read that is still there.
 */
const endOf = Effect.fn("MemoryCapturePositions.endOf")(function* (
  sql: SqlClient.SqlClient,
  batch: MemoryCaptureBatchIdentity,
  encoded: string
): Effect.fn.Return<
  { readonly rangeId: number; readonly end: PositionColumns } | undefined,
  unknown
> {
  const start = columnsOf(batch.start)
  const end = columnsOf(batch.end)
  const [row] = yield* sql<StoredRange>`
    SELECT range_id, prepared_json, prepared_cut_seq,
           EXISTS (SELECT 1 FROM session_messages AS message
             WHERE message.session_id = unread.session_id AND message.seq = ${end.read_seq}
               AND message.message_id = ${batch.endMessageId}) AS end_holds
    FROM memory_capture_unread AS unread
    WHERE session_id = ${batch.sessionId} AND read_seq = ${start.read_seq}
      AND COALESCE(read_offset, 0) = ${start.read_offset ?? 0}
  `
  if (row === undefined) return undefined
  if (row.prepared_json === encoded && row.prepared_cut_seq !== null)
    return { rangeId: row.range_id, end: { read_seq: row.prepared_cut_seq - 1, read_offset: null } }
  if (row.end_holds === 1 && (row.prepared_json === null || row.prepared_json === encoded))
    return { rangeId: row.range_id, end }
  return undefined
})

export const prepareCapture = Effect.fn("MemoryCapturePositions.prepare")(function* (
  sql: SqlClient.SqlClient,
  batch: MemoryCaptureBatchIdentity
): Effect.fn.Return<MemoryCaptureMove, unknown> {
  const encoded = yield* encodeIdentity(batch)
  const range = yield* endOf(sql, batch, encoded)
  if (range === undefined) return "superseded"
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`
    UPDATE memory_capture_unread SET prepared_json = ${encoded}, updated_at = ${now}
    WHERE range_id = ${range.rangeId}
  `
  return "moved"
})

/** Moves `range` to its end; a closed range with nothing left is deleted. */
const moveRange = Effect.fn("MemoryCapturePositions.move")(function* (
  sql: SqlClient.SqlClient,
  range: { readonly rangeId: number; readonly end: PositionColumns }
) {
  const { end } = range
  yield* sql`
    DELETE FROM memory_capture_unread
    WHERE range_id = ${range.rangeId} AND ${end.read_offset === null ? 1 : 0} = 1
      AND through_seq <= ${end.read_seq}
  `
  yield* sql`
    UPDATE memory_capture_unread
    SET read_seq = ${end.read_seq}, read_offset = ${end.read_offset}, prepared_json = NULL,
      prepared_cut_seq = NULL, updated_at = ${DateTime.formatIso(yield* DateTime.now)}
    WHERE range_id = ${range.rangeId}
  `
})

export const advanceCapture = Effect.fn("MemoryCapturePositions.advance")(function* (
  sql: SqlClient.SqlClient,
  batch: MemoryCaptureBatchIdentity
): Effect.fn.Return<MemoryCaptureMove, unknown> {
  const range = yield* endOf(sql, batch, yield* encodeIdentity(batch))
  if (range === undefined) return "superseded"
  yield* moveRange(sql, range)
  return "moved"
})

/**
 * Moves the range past `batch` as `advanceCapture` does, unread, and keeps the whole messages it
 * touched as a closed range that rests a day.
 */
export const skipCapture = Effect.fn("MemoryCapturePositions.skip")(function* (
  sql: SqlClient.SqlClient,
  batch: MemoryCaptureBatchIdentity
): Effect.fn.Return<MemoryCaptureMove, unknown> {
  const range = yield* endOf(sql, batch, yield* encodeIdentity(batch))
  if (range === undefined) return "superseded"
  yield* moveRange(sql, range)
  const start = columnsOf(batch.start)
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`
    INSERT INTO memory_capture_unread
      (session_id, read_seq, read_offset, through_seq, tried_at, updated_at)
    VALUES (${batch.sessionId}, ${start.read_seq}, ${start.read_offset}, ${range.end.read_seq},
      ${now}, ${now})
  `
  return "moved"
})

/**
 * Capture reads an owner chat from after the messages it held when it became one. A new chat
 * holds none, and a trigger starts it at its beginning (migration 0155). An Automation's working
 * copy that continues as a chat holds copies its source is read for, so it calls this before it
 * becomes an owner chat, and a trigger refuses it otherwise. A chat filled with copies after it
 * is made goes through `copyIntoOwnerChat`, the one place messages are copied between chats.
 */
export const startCaptureAfterCopies = Effect.fn("MemoryCapturePositions.start")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`
    INSERT INTO memory_capture_unread (session_id, read_seq, updated_at)
    VALUES (${sessionId},
      COALESCE((SELECT MAX(seq) FROM session_messages WHERE session_id = ${sessionId}), -1),
      ${now})
    ON CONFLICT(session_id) WHERE through_seq IS NULL DO UPDATE SET
      read_seq = excluded.read_seq, read_offset = NULL, prepared_json = NULL,
      prepared_cut_seq = NULL, updated_at = excluded.updated_at
  `
})

/**
 * Copies a chat's messages up to `throughSeq` into a new owner chat, renumbered from 0, and
 * starts Capture after them in the same step: the source is where they are read.
 */
export const copyIntoOwnerChat = Effect.fn("MemoryCapturePositions.copyIntoOwnerChat")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly from: string; readonly to: string; readonly throughSeq: number }
) {
  yield* sql`
      INSERT INTO session_messages (
        session_id, message_id, seq, role, message_json, client_id, created_at, search_text, author
      )
      SELECT ${input.to}, message_id, ROW_NUMBER() OVER (ORDER BY seq) - 1,
             role, message_json, client_id, created_at, search_text, author
      FROM session_messages
      WHERE session_id = ${input.from} AND seq <= ${input.throughSeq}
      ORDER BY seq ASC
    `
  yield* startCaptureAfterCopies(sql, input.to)
})
