import type { SqlClient, Statement } from "effect/unstable/sql"
import { awaitingApproval } from "./run-wait.js"

const pendingOnTaskAttempt = (
  sql: SqlClient.SqlClient,
  itemId: Statement.Fragment,
  pending: Statement.Fragment
) => sql`EXISTS (
  SELECT 1 FROM chat_runs AS owner JOIN space_tasks AS question_task
    ON question_task.item_id = json_extract(owner.metadata_json, '$.run_context.task.item_id')
  WHERE question_task.item_id = ${itemId}
    AND json_extract(owner.metadata_json, '$.run_context.task.item_id') = +${itemId}
    AND question_task.generation = json_extract(owner.metadata_json, '$.run_context.task.generation')
    AND (${pending})
)`

const openQuestion = (sql: SqlClient.SqlClient) =>
  sql`EXISTS (SELECT 1 FROM run_questions AS question WHERE question.run_id = owner.run_id AND question.resolution IS NULL AND question.closed_at IS NULL)`

const pendingApproval = (sql: SqlClient.SqlClient) => awaitingApproval(sql, sql`owner.run_id`)

export const hasPendingTaskQuestion = (sql: SqlClient.SqlClient, itemId: Statement.Fragment) =>
  pendingOnTaskAttempt(sql, itemId, sql`${openQuestion(sql)} OR ${pendingApproval(sql)}`)

export const hasPendingTaskApproval = (sql: SqlClient.SqlClient, itemId: Statement.Fragment) =>
  pendingOnTaskAttempt(sql, itemId, pendingApproval(sql))
