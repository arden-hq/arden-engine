import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import {
  MemoryCaptureBatchIdentitySchema,
  type MemoryCaptureBacklog,
  type MemoryCaptureBacklogPart,
  type MemoryCaptureBatchIdentity,
  type MemoryCaptureMove,
  type MemoryCapturePosition,
  type MemoryCaptureWork
} from "../memory/store.js"
import { userChatSql } from "./chat-ownership.js"
import { activeRunStatusList } from "./status-sets.js"

// The one writer of `memory_capture_positions`: how far Capture has read each owner chat.
// The transcript owns where a chat ends, so the end is never stored. A trigger on
// `session_messages` moves a position back when messages it covers are deleted
// (revert, clear), because new messages then reuse their numbers, and marks where a deletion
// cut a prepared batch (migration 0158).

/** Characters Capture reads in one batch; the backlog count uses it to estimate batches. */
export const CAPTURE_CHAR_LIMIT = 6_000

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

const samePosition = (left: PositionColumns, right: PositionColumns): boolean =>
  left.read_seq === right.read_seq && left.read_offset === right.read_offset

const encodeIdentity = (identity: MemoryCaptureBatchIdentity) =>
  Schema.encodeEffect(IdentityJson)(identity)

interface WorkRow extends PositionColumns {
  readonly session_id: string
  readonly through_seq: number
  readonly prepared_json: string | null
}

/**
 * Owner chats, archived ones included, that have a prepared batch to finish, or messages past
 * their position while no run is active in them. Prepared batches first, then the chat whose
 * oldest unread message is oldest.
 */
export const listCaptureWork = Effect.fn("MemoryCapturePositions.listWork")(function* (
  sql: SqlClient.SqlClient,
  limit: number
) {
  const rows = yield* sql<WorkRow>`
    WITH chats AS (
      SELECT session.session_id,
             position.read_seq,
             position.read_offset,
             position.prepared_json,
             CASE WHEN position.prepared_cut_seq IS NULL
               THEN (SELECT MAX(seq) FROM session_messages AS message
                 WHERE message.session_id = session.session_id)
               ELSE position.prepared_cut_seq - 1 END AS through_seq,
             EXISTS (SELECT 1 FROM chat_runs AS run
               WHERE run.session_id = session.session_id
                 AND run.status IN ${activeRunStatusList}) AS running
      FROM sessions AS session
      JOIN memory_capture_positions AS position ON position.session_id = session.session_id
      WHERE ${userChatSql("session")}
    )
    SELECT session_id, read_seq, read_offset, prepared_json, through_seq
    FROM chats
    WHERE through_seq IS NOT NULL
      AND (prepared_json IS NOT NULL
        OR (running = 0 AND (through_seq > read_seq OR read_offset IS NOT NULL)))
    ORDER BY prepared_json IS NULL,
      (SELECT created_at FROM session_messages AS message
        WHERE message.session_id = chats.session_id
          AND message.seq > chats.read_seq - (chats.read_offset IS NOT NULL)
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

interface StoredPosition extends PositionColumns {
  readonly prepared_json: string | null
  readonly prepared_cut_seq: number | null
  readonly end_holds: number
}

/**
 * Where the chat's position goes when `batch` is read, or undefined when the chat moved on: the
 * position is not at the batch's start, another batch is prepared, or the message at its end is
 * gone. When a revert removed later messages of the prepared batch, it ends before the first
 * one removed: the last message it read that is still there.
 */
const endOf = Effect.fn("MemoryCapturePositions.endOf")(function* (
  sql: SqlClient.SqlClient,
  batch: MemoryCaptureBatchIdentity,
  encoded: string
): Effect.fn.Return<PositionColumns | undefined, unknown> {
  const end = columnsOf(batch.end)
  const rows = yield* sql<StoredPosition>`
    SELECT read_seq, read_offset, prepared_json, prepared_cut_seq,
           EXISTS (SELECT 1 FROM session_messages AS message
             WHERE message.session_id = position.session_id AND message.seq = ${end.read_seq}
               AND message.message_id = ${batch.endMessageId}) AS end_holds
    FROM memory_capture_positions AS position
    WHERE position.session_id = ${batch.sessionId}
  `
  const row = rows[0]
  if (row === undefined || !samePosition(row, columnsOf(batch.start))) return undefined
  if (row.prepared_json === encoded && row.prepared_cut_seq !== null)
    return { read_seq: row.prepared_cut_seq - 1, read_offset: null }
  if (row.end_holds === 1 && (row.prepared_json === null || row.prepared_json === encoded))
    return end
  return undefined
})

export const prepareCapture = Effect.fn("MemoryCapturePositions.prepare")(function* (
  sql: SqlClient.SqlClient,
  batch: MemoryCaptureBatchIdentity
): Effect.fn.Return<MemoryCaptureMove, unknown> {
  const encoded = yield* encodeIdentity(batch)
  if ((yield* endOf(sql, batch, encoded)) === undefined) return "superseded"
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`
    UPDATE memory_capture_positions SET prepared_json = ${encoded}, updated_at = ${now}
    WHERE session_id = ${batch.sessionId}
  `
  return "moved"
})

export const advanceCapture = Effect.fn("MemoryCapturePositions.advance")(function* (
  sql: SqlClient.SqlClient,
  batch: MemoryCaptureBatchIdentity
): Effect.fn.Return<MemoryCaptureMove, unknown> {
  const end = yield* endOf(sql, batch, yield* encodeIdentity(batch))
  if (end === undefined) return "superseded"
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`
    UPDATE memory_capture_positions
    SET read_seq = ${end.read_seq}, read_offset = ${end.read_offset}, prepared_json = NULL,
      prepared_cut_seq = NULL, updated_at = ${now}
    WHERE session_id = ${batch.sessionId}
  `
  return "moved"
})

/**
 * Capture reads an owner chat from after the messages it held when it became one. A new chat
 * holds none, and a trigger starts it at its beginning (migration 0157). A branch, and an
 * Automation's working copy that continues as a chat, hold copies their source is read for, so
 * every producer of such a chat calls this; a trigger refuses a chat that becomes an owner chat
 * before it does.
 */
export const startCaptureAfterCopies = Effect.fn("MemoryCapturePositions.start")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`
    INSERT INTO memory_capture_positions (session_id, read_seq, read_offset, prepared_json, updated_at)
    VALUES (${sessionId},
      COALESCE((SELECT MAX(seq) FROM session_messages WHERE session_id = ${sessionId}), -1),
      NULL, NULL, ${now})
    ON CONFLICT(session_id) DO UPDATE SET
      read_seq = excluded.read_seq, read_offset = NULL, prepared_json = NULL,
      updated_at = excluded.updated_at
  `
})

interface BacklogPartRow {
  readonly before: number
  readonly chats: number
  readonly typed_turns: number
  readonly user_characters: number
  readonly assistant_characters: number
}

/**
 * Counts the old unread messages kept out of Capture's work, split by when they were written,
 * and the uncached input a Capture run used over the last 30 days. Reads no message text.
 */
export const countCaptureBacklog = Effect.fn("MemoryCapturePositions.backlogCount")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly splitAt: string }
): Effect.fn.Return<MemoryCaptureBacklog, unknown> {
  const ranges = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM memory_capture_backlog`
  const parts = yield* sql<BacklogPartRow>`
    WITH unread AS (
      SELECT message.session_id,
             message.created_at < ${input.splitAt} AS before,
             message.role,
             LENGTH(COALESCE(message.search_text, '')) AS characters,
             message.role = 'user'
               AND json_extract(message.message_json, '$.is_meta') IS NULL
               AND EXISTS (SELECT 1 FROM session_turns AS turn
                 WHERE turn.session_id = message.session_id
                   AND turn.user_message_id = message.message_id) AS typed
      FROM memory_capture_backlog AS backlog
      JOIN session_messages AS message ON message.session_id = backlog.session_id
        AND message.seq BETWEEN backlog.from_seq AND backlog.through_seq
    )
    SELECT before,
           COUNT(DISTINCT session_id) AS chats,
           SUM(typed) AS typed_turns,
           SUM(CASE WHEN role = 'user' THEN characters ELSE 0 END) AS user_characters,
           SUM(CASE WHEN role = 'assistant' THEN characters ELSE 0 END) AS assistant_characters
    FROM unread
    GROUP BY before`
  const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 30 }))
  const usage = yield* sql<{ readonly tokens: number | null }>`
    SELECT AVG((SELECT SUM(COALESCE(json_extract(usage.usage_json, '$.prompt'), 0))
                FROM run_model_usage AS usage WHERE usage.run_id = run.run_id)) AS tokens
    FROM chat_runs AS run
    WHERE run.started_at >= ${since}
      AND json_type(run.metadata_json, '$.memory_capture_batch') = 'object'
      AND EXISTS (SELECT 1 FROM run_model_usage AS used WHERE used.run_id = run.run_id)`
  const part = (before: 0 | 1): MemoryCaptureBacklogPart => {
    const row = parts.find((candidate) => candidate.before === before)
    if (row === undefined)
      return { chats: 0, typedTurns: 0, userCharacters: 0, assistantCharacters: 0, batches: 0 }
    return {
      chats: row.chats,
      typedTurns: row.typed_turns,
      userCharacters: row.user_characters,
      assistantCharacters: row.assistant_characters,
      batches: Math.ceil((row.user_characters + row.assistant_characters) / CAPTURE_CHAR_LIMIT)
    }
  }
  const tokens = usage[0]?.tokens ?? null
  return {
    ranges: ranges[0]?.count ?? 0,
    before: part(1),
    since: part(0),
    freshTokensPerBatch: tokens === null ? undefined : Math.round(tokens)
  }
})
