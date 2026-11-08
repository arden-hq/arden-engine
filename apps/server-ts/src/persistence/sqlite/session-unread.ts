import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { messageTurnIdSql } from "./message-turns.js"
import { readableConversationSql } from "./session-presentation.js"
import { conversationMessagePredicate } from "./transcript.js"

export const turnTouchesRecencySql = (
  sql: SqlClient.SqlClient,
  options: { readonly sessionId: string; readonly turnId: string }
) => sql`(
  NOT EXISTS (SELECT 1 FROM session_messages AS update_input
    WHERE update_input.session_id = ${options.sessionId} AND update_input.message_id = ${options.turnId}
      AND json_type(update_input.message_json, '$.update') = 'object')
  OR EXISTS (SELECT 1 FROM session_messages AS m
    WHERE m.session_id = ${options.sessionId}
      AND ${messageTurnIdSql(sql, "m")} = ${options.turnId}
      AND m.role = 'assistant'
      AND ${conversationMessagePredicate(sql)}))`

export const liftChat = Effect.fn("SessionUnread.liftChat")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: Pick<
    SessionLifecycleEvents["Service"],
    "appendEventInTransaction" | "appendInTransaction"
  >,
  options: { readonly sessionId: string; readonly at: string }
) {
  const rows = yield* sql<{ readonly session_id: string }>`UPDATE sessions
    SET last_activity = ${options.at},
      has_unread = CASE WHEN ${readableConversationSql(sql)} THEN 1 ELSE has_unread END
    WHERE session_id = ${options.sessionId} AND archived_at IS NULL
    RETURNING session_id`
  if (rows.length > 0)
    yield* sessionEvents.appendInTransaction("session_activity", options.sessionId)
})
