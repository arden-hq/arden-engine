import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const movedThreadLeftovers: Migration = {
  version: 34,
  name: "moved_thread_leftovers",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    removeGoneTurnQuestions(database)
    removeMovedThreadRows(database)
  }
}

const removeGoneTurnQuestions = (database: DatabaseSync): void => {
  database.exec(`CREATE TEMP TABLE gone_turn_questions AS
    SELECT question.question_id FROM run_questions AS question
    JOIN chat_runs AS run ON run.run_id = question.run_id
    WHERE json_extract(run.metadata_json, '$.turn_id') IS NOT NULL
      AND json_extract(run.metadata_json, '$.run_context.task') IS NULL
      AND EXISTS (SELECT 1 FROM session_turns AS turn WHERE turn.session_id = run.session_id)
      AND NOT EXISTS (SELECT 1 FROM session_turns AS turn
        WHERE turn.session_id = run.session_id
          AND turn.turn_id = json_extract(run.metadata_json, '$.turn_id'))`)
  for (const table of ["focus_choices", "desk_task_holds", "run_questions"])
    database.exec(
      `DELETE FROM ${table} WHERE question_id IN (SELECT question_id FROM gone_turn_questions)`
    )
  database.exec("DROP TABLE temp.gone_turn_questions")
}

const removeMovedThreadRows = (database: DatabaseSync): void => {
  database.exec(`CREATE TEMP TABLE moved_thread_rows AS
    SELECT message.session_id, message.seq,
      message.role NOT IN ('system', 'developer')
        AND json_type(message.message_json, '$.forked_from') IS NOT 'text' AS visible,
      session.context_from_seq IS NOT NULL
        AND (message.seq >= session.context_from_seq OR message.seq = session.context_head_seq)
        AND NOT EXISTS (SELECT 1 FROM session_context_hidden AS hidden
          WHERE hidden.session_id = message.session_id AND hidden.seq = message.seq) AS in_window
    FROM session_messages AS message
    JOIN sessions AS session ON session.session_id = message.session_id
    WHERE message.message_id LIKE 'thread-moved:%' AND message.role = 'assistant'`)
  database.exec(`UPDATE sessions SET
      active_message_count = active_message_count - (SELECT count(*) FROM moved_thread_rows AS row
        WHERE row.session_id = sessions.session_id AND row.in_window),
      visible_message_count = visible_message_count - (SELECT count(*) FROM moved_thread_rows AS row
        WHERE row.session_id = sessions.session_id AND row.in_window AND row.visible)
    WHERE session_id IN (SELECT session_id FROM moved_thread_rows)`)
  database.exec(`DELETE FROM session_context_hidden
    WHERE (session_id, seq) IN (SELECT session_id, seq FROM moved_thread_rows)`)
  database.exec(`DELETE FROM session_messages
    WHERE (session_id, seq) IN (SELECT session_id, seq FROM moved_thread_rows)`)
  const affected = database
    .prepare("SELECT session_id, MIN(seq) AS from_seq FROM moved_thread_rows GROUP BY session_id")
    .all()
  for (const row of affected) rebuildTurns(database, String(row.session_id), Number(row.from_seq))
  database.exec("DROP TABLE temp.moved_thread_rows")
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
