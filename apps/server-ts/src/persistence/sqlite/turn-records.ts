import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { appendQuestionChanges } from "./question-events.js"
import { messageTurnIdSql } from "./message-turns.js"

export const turnIdsOf = Effect.fn("Sqlite.turnIdsOf")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  messageIds: ReadonlyArray<string>
) {
  if (messageIds.length === 0) return []
  const rows = yield* sql<{ readonly turn_id: string }>`
    SELECT DISTINCT ${messageTurnIdSql(sql, "session_messages")} AS turn_id
    FROM session_messages
    WHERE session_id = ${sessionId} AND message_id IN ${sql.in(messageIds)}
      AND ${messageTurnIdSql(sql, "session_messages")} IS NOT NULL`
  return rows.map((row) => row.turn_id)
})

export const deleteGoneTurnRecordsInTransaction = Effect.fn("Sqlite.deleteGoneTurnRecords")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: Pick<SessionLifecycleEvents["Service"], "appendEventInTransaction">
    readonly sessionId: string
    readonly turnIds: ReadonlyArray<string>
  }) {
    const { sql } = options
    if (options.turnIds.length === 0) return
    const questions = yield* sql<{ readonly question_id: string }>`SELECT question.question_id
      FROM run_questions AS question
      JOIN chat_runs AS run ON run.run_id = question.run_id
      WHERE run.session_id = ${options.sessionId}
        AND json_extract(run.metadata_json, '$.turn_id') IN ${sql.in(options.turnIds)}
        AND json_extract(run.metadata_json, '$.run_context.task') IS NULL
        AND NOT EXISTS (SELECT 1 FROM session_turns AS turn
          WHERE turn.session_id = run.session_id
            AND turn.turn_id = json_extract(run.metadata_json, '$.turn_id'))`
    const questionIds = questions.map((question) => question.question_id)
    if (questionIds.length === 0) return
    yield* appendQuestionChanges({ sql, sessionEvents: options.sessionEvents, questionIds })
    yield* sql`DELETE FROM focus_choices WHERE question_id IN ${sql.in(questionIds)}`
    yield* sql`DELETE FROM space_task_holds WHERE question_id IN ${sql.in(questionIds)}`
    yield* sql`DELETE FROM run_questions WHERE question_id IN ${sql.in(questionIds)}`
  }
)
