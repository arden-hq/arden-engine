import type { SqlClient, Statement } from "effect/unstable/sql"

export const taskConversationSql = (
  sql: SqlClient.SqlClient,
  itemId: Statement.Fragment
): Statement.Fragment => sql`(
  SELECT COALESCE(
    (SELECT home.session_id FROM sessions AS home
      WHERE home.session_id = conversation_task.home_session_id AND home.archived_at IS NULL),
    conversation.session_id, conversation_task.home_session_id)
  FROM space_tasks AS conversation_task
  LEFT JOIN space_conversations AS conversation ON conversation.space_id = conversation_task.space_id
  WHERE conversation_task.item_id = ${itemId}
)`
