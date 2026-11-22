import { CHAT_MESSAGE_MAX_LENGTH, type ChatReplyContext } from "@arden-hq/protocol/chat"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { cutText } from "@arden-hq/std/text"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { userContent } from "../transcript/user-content.js"

export const messageQuote = Effect.fn("MessageQuote.read")(function* (
  sql: SqlClient.SqlClient,
  where: { readonly sessionId: string; readonly messageId: string }
) {
  const rows = yield* sql<{
    readonly role: string
    readonly content: string | null
    readonly content_type: string | null
  }>`SELECT role, json_extract(message_json, '$.content') AS content,
      json_type(message_json, '$.content') AS content_type
    FROM session_messages
    WHERE session_id = ${where.sessionId} AND message_id = ${where.messageId}`
  const row = rows[0]
  if (row === undefined || row.content === null) return undefined
  if (row.role !== ROLE.user && row.role !== ROLE.assistant) return undefined
  const content: unknown = row.content_type === "array" ? JSON.parse(row.content) : row.content
  const text = userContent(content).text
  if (text === "") return undefined
  return {
    messageId: where.messageId,
    role: row.role,
    content: cutText(text, CHAT_MESSAGE_MAX_LENGTH)
  } satisfies ChatReplyContext
})
