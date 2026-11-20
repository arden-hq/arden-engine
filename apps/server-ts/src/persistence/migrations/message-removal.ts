import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { DatabaseSync } from "node:sqlite"

export interface ColumnPosition {
  readonly table: string
  readonly chat: string
  readonly column: string
}

interface MetadataPosition {
  readonly chatPath: string
  readonly path: string
}

export const THROUGH_POSITIONS: ReadonlyArray<ColumnPosition> = [
  { table: "chat_summaries", chat: "session_id", column: "through_sequence" },
  { table: "chat_runs", chat: "session_id", column: "last_seq" },
  { table: "memory_capture_unread", chat: "session_id", column: "read_seq" },
  { table: "memory_capture_unread", chat: "session_id", column: "through_seq" }
]

export const FROM_POSITIONS: ReadonlyArray<ColumnPosition> = [
  { table: "sessions", chat: "session_id", column: "context_from_seq" }
]

export const ROW_POSITIONS: ReadonlyArray<ColumnPosition> = [
  { table: "sessions", chat: "session_id", column: "context_head_seq" },
  { table: "chat_compactions", chat: "session_id", column: "boundary_seq" }
]

const FORK_THROUGH_POSITIONS: ReadonlyArray<MetadataPosition> = [
  { chatPath: "$.fork_origin.sourceSessionId", path: "$.fork_origin.throughSequence" },
  { chatPath: "$.fork_of.source_session_id", path: "$.fork_of.through_sequence" }
]

const FORK_MESSAGE_POSITIONS: ReadonlyArray<MetadataPosition> = [
  { chatPath: "$.fork_origin.sourceSessionId", path: "$.fork_origin.sourceMessageId" }
]

const TRIGGER_CUT_TABLES = ["chat_summaries", "memory_capture_unread"] as const

const keptThrough = (chat: string, position: string): string =>
  `(SELECT MAX(kept.seq) FROM session_messages AS kept
    WHERE kept.session_id = ${chat} AND kept.seq <= ${position})`

const keptFrom = (chat: string, position: string): string =>
  `COALESCE((SELECT MIN(kept.seq) FROM session_messages AS kept
      WHERE kept.session_id = ${chat} AND kept.seq >= ${position}),
    (SELECT MAX(kept.seq) + 1 FROM session_messages AS kept WHERE kept.session_id = ${chat}), 0)`

const namesRemovedOrPastEnd = (chat: string, position: string): string =>
  `(${position} IS NOT NULL AND ${chat} IN (SELECT session_id FROM temp.removed_transcript_rows)
    AND ((${chat}, ${position}) IN (SELECT session_id, seq FROM temp.removed_transcript_rows)
      OR ${position} > COALESCE((SELECT MAX(kept.seq) FROM session_messages AS kept
        WHERE kept.session_id = ${chat}), -1)))`

const tableIn = (table: string): string =>
  (TRIGGER_CUT_TABLES as ReadonlyArray<string>).includes(table) ? `temp.kept_${table}` : table

export const removeTranscriptRows = (database: DatabaseSync, selection: string): void => {
  database.exec(`CREATE TEMP TABLE removed_transcript_rows AS
    SELECT message.session_id, message.seq, message.message_id,
      message.role NOT IN ('${ROLE.system}', '${ROLE.developer}')
        AND json_type(message.message_json, '$.forked_from') IS NOT 'text' AS visible,
      session.context_from_seq IS NOT NULL
        AND (message.seq >= session.context_from_seq OR message.seq = session.context_head_seq)
        AND NOT EXISTS (SELECT 1 FROM session_context_hidden AS hidden
          WHERE hidden.session_id = message.session_id AND hidden.seq = message.seq) AS in_window
    FROM session_messages AS message
    JOIN sessions AS session ON session.session_id = message.session_id
    WHERE (message.session_id, message.seq) IN (${selection})`)
  refuseRemovedRowPositions(database)
  database.exec(`UPDATE sessions SET
      active_message_count = active_message_count - (SELECT count(*) FROM removed_transcript_rows AS row
        WHERE row.session_id = sessions.session_id AND row.in_window),
      visible_message_count = visible_message_count - (SELECT count(*) FROM removed_transcript_rows AS row
        WHERE row.session_id = sessions.session_id AND row.in_window AND row.visible)
    WHERE session_id IN (SELECT session_id FROM removed_transcript_rows)`)
  database.exec(`DELETE FROM session_context_hidden
    WHERE (session_id, seq) IN (SELECT session_id, seq FROM removed_transcript_rows)`)
  for (const table of TRIGGER_CUT_TABLES)
    database.exec(`CREATE TEMP TABLE kept_${table} AS SELECT * FROM ${table}
      WHERE session_id IN (SELECT session_id FROM removed_transcript_rows)`)
  dropPreparedCaptureOverRemovedRows(database)
  const affected = database
    .prepare(
      `SELECT row.session_id, MIN(row.seq) AS from_seq FROM removed_transcript_rows AS row
      WHERE EXISTS (SELECT 1 FROM session_turns AS turn
        WHERE turn.session_id = row.session_id
          AND (turn.message_start_seq = row.seq OR turn.message_end_seq = row.seq))
      GROUP BY row.session_id`
    )
    .all()
  database.exec(`DELETE FROM session_messages
    WHERE (session_id, seq) IN (SELECT session_id, seq FROM removed_transcript_rows)`)
  movePositionsToKeptRows(database)
  for (const table of TRIGGER_CUT_TABLES) {
    database.exec(
      `DELETE FROM ${table} WHERE session_id IN (SELECT session_id FROM removed_transcript_rows)`
    )
    database.exec(`INSERT INTO ${table} SELECT * FROM temp.kept_${table}`)
    database.exec(`DROP TABLE temp.kept_${table}`)
  }
  for (const row of affected) rebuildTurns(database, String(row.session_id), Number(row.from_seq))
  database.exec("DROP TABLE temp.removed_transcript_rows")
}

const refuseRemovedRowPositions = (database: DatabaseSync): void => {
  for (const position of ROW_POSITIONS) {
    const named = database
      .prepare(
        `SELECT ${position.chat} AS chat, ${position.column} AS seq FROM ${position.table}
        WHERE (${position.chat}, ${position.column}) IN
          (SELECT session_id, seq FROM temp.removed_transcript_rows) LIMIT 1`
      )
      .get()
    if (named !== undefined)
      throw new Error(
        `${position.table}.${position.column} names removed message ${String(named.chat)}#${String(named.seq)}`
      )
  }
}

const dropPreparedCaptureOverRemovedRows = (database: DatabaseSync): void => {
  database.exec(`UPDATE temp.kept_memory_capture_unread AS positioned
    SET prepared_json = NULL, prepared_cut_seq = NULL
    WHERE positioned.prepared_json IS NOT NULL AND EXISTS (SELECT 1 FROM temp.removed_transcript_rows AS row
      WHERE row.session_id = positioned.session_id AND row.seq > positioned.read_seq
        AND row.seq <= MAX(COALESCE(json_extract(positioned.prepared_json, '$.end.sequence'),
            json_extract(positioned.prepared_json, '$.end.progress.sequence'), -1),
          COALESCE(positioned.prepared_cut_seq, -1)))`)
}

const movePositionsToKeptRows = (database: DatabaseSync): void => {
  database.exec(`UPDATE temp.kept_memory_capture_unread AS positioned SET read_offset = NULL
    WHERE ${namesRemovedOrPastEnd("positioned.session_id", "positioned.read_seq")}`)
  for (const position of THROUGH_POSITIONS) {
    const chat = `positioned.${position.chat}`
    const at = `positioned.${position.column}`
    database.exec(`UPDATE ${tableIn(position.table)} AS positioned
      SET ${position.column} = COALESCE(${keptThrough(chat, at)}, -1)
      WHERE ${namesRemovedOrPastEnd(chat, at)}`)
  }
  for (const position of FROM_POSITIONS) {
    const chat = `positioned.${position.chat}`
    const at = `positioned.${position.column}`
    database.exec(`UPDATE ${tableIn(position.table)} AS positioned
      SET ${position.column} = ${keptFrom(chat, at)}
      WHERE ${namesRemovedOrPastEnd(chat, at)}`)
  }
  database.exec(`DELETE FROM temp.kept_memory_capture_unread
    WHERE through_seq IS NOT NULL AND through_seq < read_seq + (read_offset IS NULL)`)
  database.exec(`DELETE FROM temp.kept_chat_summaries WHERE through_sequence < 0`)
  for (const position of FORK_MESSAGE_POSITIONS) {
    const chat = `json_extract(positioned.metadata, '${position.chatPath}')`
    const named = `json_extract(positioned.metadata, '${position.path}')`
    database.exec(`UPDATE sessions AS positioned SET metadata = json_set(metadata, '${position.path}',
        (SELECT kept.message_id FROM session_messages AS kept
          JOIN temp.removed_transcript_rows AS row
            ON row.session_id = ${chat} AND row.message_id = ${named}
          WHERE kept.session_id = row.session_id AND kept.seq < row.seq
          ORDER BY kept.seq DESC LIMIT 1))
      WHERE json_valid(positioned.metadata) AND EXISTS (SELECT 1 FROM temp.removed_transcript_rows AS row
        WHERE row.session_id = ${chat} AND row.message_id = ${named})`)
  }
  for (const position of FORK_THROUGH_POSITIONS) {
    const chat = `json_extract(positioned.metadata, '${position.chatPath}')`
    const at = `json_extract(positioned.metadata, '${position.path}')`
    database.exec(`UPDATE sessions AS positioned SET metadata = json_set(metadata, '${position.path}',
        COALESCE(${keptThrough(chat, at)}, -1))
      WHERE json_valid(positioned.metadata) AND ${namesRemovedOrPastEnd(chat, at)}`)
  }
}

const rebuildTurns = (database: DatabaseSync, sessionId: string, fromSeq: number): void => {
  const affected = database
    .prepare(
      `SELECT MIN(message_start_seq) AS start_seq FROM session_turns
      WHERE session_id = ? AND message_end_seq >= ?`
    )
    .get(sessionId, fromSeq)
  const scanFrom = Math.min(fromSeq, Number(affected?.start_seq ?? fromSeq))
  database
    .prepare("DELETE FROM session_turns WHERE session_id = ? AND message_end_seq >= ?")
    .run(sessionId, fromSeq)
  database
    .prepare(
      `WITH turns AS (
        SELECT json_extract(message_json, '$.turn_id') AS turn_id,
               MIN(seq) AS start_seq, MAX(seq) AS end_seq,
               MIN(created_at) AS started_at, MAX(created_at) AS ended_at,
               ROW_NUMBER() OVER (ORDER BY MIN(seq)) - 1 AS turn_rank
        FROM session_messages
        WHERE session_id = :session AND seq >= :from
          AND json_extract(message_json, '$.turn_id') IS NOT NULL
          AND json_extract(message_json, '$.turn_id') NOT IN (
            SELECT turn_id FROM session_turns WHERE session_id = :session
          )
        GROUP BY json_extract(message_json, '$.turn_id')
      ),
      base AS (
        SELECT COALESCE(MAX(turn_index) + 1, 0) AS next_index
        FROM session_turns WHERE session_id = :session
      )
      INSERT INTO session_turns (
        session_id, turn_id, turn_index, user_message_id,
        message_start_id, message_end_id, message_start_seq, message_end_seq,
        started_at, ended_at
      )
      SELECT :session, turns.turn_id, base.next_index + turns.turn_rank, turns.turn_id,
             starting.message_id, ending.message_id, turns.start_seq, turns.end_seq,
             turns.started_at, turns.ended_at
      FROM turns
      CROSS JOIN base
      JOIN session_messages AS starting
        ON starting.session_id = :session AND starting.seq = turns.start_seq
      JOIN session_messages AS ending
        ON ending.session_id = :session AND ending.seq = turns.end_seq
      ORDER BY turns.turn_rank`
    )
    .run({ session: sessionId, from: scanFrom })
}
