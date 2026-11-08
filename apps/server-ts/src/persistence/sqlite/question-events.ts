import { journalRecordsSql } from "@arden-hq/journal/effect"
import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { SessionLifecycleEventError, SessionLifecycleEvents } from "../sessions/events.js"
import { SESSION_LIFECYCLE_STREAM_ID } from "../sessions/events.js"
import { toldKey, UnitOfWork } from "../unit-of-work.js"
import { runColumns, runDestinationSessionId, type RunColumns } from "./run-destination.js"
import { taskOpenSql } from "./task-status-sql.js"

const questionTaskAuthorityPredicate = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment
) => sql`(
  json_extract(${metadata}, '$.run_context.task.item_id') IS NULL
  OR EXISTS (
    SELECT 1 FROM space_tasks AS question_task
    LEFT JOIN spaces AS question_task_space ON question_task_space.space_id = question_task.space_id
    WHERE question_task.item_id = json_extract(${metadata}, '$.run_context.task.item_id')
      AND question_task.generation = json_extract(${metadata}, '$.run_context.task.generation')
      AND ${taskOpenSql("question_task")}
      AND (question_task.space_id IS NULL OR question_task_space.archived_at IS NULL)
  )
)`

export const runAsksVisiblePredicate = (sql: SqlClient.SqlClient, run: RunColumns) =>
  sql`${questionTaskAuthorityPredicate(sql, run.metadata)}
    AND EXISTS (
      SELECT 1 FROM sessions AS question_destination
      LEFT JOIN spaces AS question_destination_space
        ON question_destination_space.space_id = question_destination.space_id
      WHERE question_destination.session_id = ${runDestinationSessionId(sql, run)}
        AND question_destination.archived_at IS NULL
        AND (
          question_destination.space_id IS NULL
          OR question_destination_space.archived_at IS NULL
        )
    )`

export const questionVisiblePredicate = (options: {
  readonly sql: SqlClient.SqlClient
  readonly run: RunColumns
  readonly resolution: Statement.Fragment
  readonly closedAt: Statement.Fragment
}) => {
  const { sql, run, resolution, closedAt } = options
  return sql`${resolution} IS NULL AND ${closedAt} IS NULL
    AND ${runAsksVisiblePredicate(sql, run)}`
}

export const latestSettledQuestionChanges = (sql: SqlClient.SqlClient) => sql`
  SELECT question.question_id, latest.sequence AS revision,
    CASE WHEN question.resolution IS NOT NULL THEN 'resolved' ELSE 'closed' END AS status,
    destination.space_id AS destination_space_id,
    destination.session_id AS destination_session_id
  FROM run_questions AS question
  JOIN chat_runs AS run ON run.run_id = question.run_id
  JOIN ${journalRecordsSql(sql)} AS latest
    ON latest.stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
    AND latest.event_type = 'question_changed'
    AND latest.sequence = (
      SELECT MAX(record.sequence)
      FROM ${journalRecordsSql(sql)} AS record
      WHERE record.stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
        AND record.event_type = 'question_changed'
        AND json_extract(record.data_json, '$.question_id') = question.question_id
    )
  JOIN sessions AS destination
    ON destination.session_id = ${runDestinationSessionId(sql, runColumns(sql, "run"))}
    AND destination.session_id = json_extract(latest.data_json, '$.session_id')
  WHERE question.resolution IS NOT NULL OR question.closed_at IS NOT NULL`

export const appendQuestionChange = Effect.fn(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: Pick<SessionLifecycleEvents["Service"], "appendEventInTransaction">
  readonly questionId: string
}) {
  const rows = yield* options.sql<{
    readonly run_id: string
    readonly session_id: string
    readonly item_id: string | null
  }>`SELECT q.run_id,
    ${runDestinationSessionId(options.sql, runColumns(options.sql, "r"))} AS session_id,
    json_extract(r.metadata_json, '$.run_context.task.item_id') AS item_id
    FROM run_questions AS q JOIN chat_runs AS r ON r.run_id = q.run_id
    WHERE q.question_id = ${options.questionId}`
  const row = rows[0]
  if (!row) return false
  yield* (yield* UnitOfWork).markTold(toldKey.question(options.questionId))
  yield* options.sessionEvents.appendEventInTransaction({
    type: "question_changed",
    question_id: options.questionId,
    ...row
  })
  return true
})

export const appendQuestionChanges = Effect.fn("QuestionEvents.appendMany")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: Pick<SessionLifecycleEvents["Service"], "appendEventInTransaction">
  readonly questionIds: ReadonlyArray<string>
}): Effect.fn.Return<void, SessionLifecycleEventError | SqlError, UnitOfWork> {
  const questionIds = [...new Set(options.questionIds)].sort()
  yield* Effect.forEach(
    questionIds,
    (questionId) =>
      appendQuestionChange({
        sql: options.sql,
        sessionEvents: options.sessionEvents,
        questionId
      }),
    { discard: true }
  )
})

export const readOpenTaskQuestionIds = Effect.fn("QuestionEvents.readOpenTask")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
): Effect.fn.Return<ReadonlyArray<string>, SqlError> {
  const rows = yield* sql<{ readonly question_id: string }>`
    SELECT question.question_id
    FROM run_questions AS question
    JOIN chat_runs AS run ON run.run_id = question.run_id
    WHERE ${questionVisiblePredicate({
      sql,
      run: runColumns(sql, "run"),
      resolution: sql`question.resolution`,
      closedAt: sql`question.closed_at`
    })}
      AND json_extract(run.metadata_json, '$.run_context.task.item_id') = ${itemId}
    ORDER BY question.question_id`
  return rows.map((row) => row.question_id)
})
