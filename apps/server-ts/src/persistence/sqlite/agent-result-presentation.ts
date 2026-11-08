import { AgentResultSchema } from "@arden-hq/protocol/effect/chat"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { previewLine } from "../transcript/preview-line.js"

export const agentResultPresentation = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  messageId: string
) {
  const rows = yield* sql<{
    readonly session_id: string
    readonly name: string
    readonly content: string
  }>`
    SELECT child.session_id, COALESCE(NULLIF(child.name, ''), 'Agent') AS name, d.body AS content
    FROM automation_deliveries d
    JOIN chat_runs r ON r.run_id = json_extract(d.payload, '$.runIds[0]')
    JOIN sessions child ON child.session_id = r.session_id
    WHERE d.delivery_id = ${messageId.slice("arrival:".length)}
      AND ${messageId} = 'arrival:' || d.delivery_id
      AND json_extract(d.payload, '$.kind') = 'result'
      AND json_extract(d.payload, '$.sessionId') = ${sessionId}
      AND child.session_type = 'agent' AND child.parent_session_id = ${sessionId}
    LIMIT 1`
  const row = rows[0]
  if (row === undefined) return undefined
  const result = yield* Schema.decodeUnknownEffect(AgentResultSchema)(row)
  const preview = previewLine(result.content)
  return preview === null ? result : { ...result, preview }
})

export const agentResultMessagePredicate = (sql: SqlClient.SqlClient) => sql`EXISTS (
  SELECT 1 FROM automation_deliveries d
  JOIN chat_runs r ON r.run_id = json_extract(d.payload, '$.runIds[0]')
  JOIN sessions child ON child.session_id = r.session_id
  WHERE d.delivery_id = substr(m.message_id, 9)
    AND m.message_id = 'arrival:' || d.delivery_id
    AND json_extract(d.payload, '$.kind') = 'result'
    AND json_extract(d.payload, '$.sessionId') = m.session_id
    AND child.session_type = 'agent' AND child.parent_session_id = m.session_id
)`
