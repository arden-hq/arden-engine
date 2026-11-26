import { ROLE } from "@arden-hq/std/message-vocabulary"
import { disposableForkSql } from "../schema/fork-disposition.js"
import { agentResultMessagePredicate } from "./agent-result-presentation.js"
import type { SqlClient } from "effect/unstable/sql"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"
export const conversationCallPredicate = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`
    (
      COALESCE(json_extract(call.value, '$.presentation'), '') = 'conversation'
    )
  `

export const communicationToldSql = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`(json_extract(m.message_json, '$.communication') IS NOT NULL
    AND json_extract(m.message_json, '$.communication.arrival.event') IS NOT 'needs_you')`

export const ownMessagePredicate = (sql: SqlClient.SqlClient): Statement<Row> => sql`
  json_type(m.message_json, '$.forked_from') IS NOT 'text'
  AND NOT EXISTS (
    SELECT 1 FROM session_fork_requests AS fork
    JOIN sessions AS child ON child.session_id = fork.child_session_id
    JOIN session_messages AS boundary ON boundary.session_id = child.session_id
      AND boundary.message_id = json_extract(child.metadata, '$.fork_origin.sourceMessageId')
    WHERE fork.child_session_id = m.session_id
      AND ${sql.literal(disposableForkSql("fork"))}
      AND m.seq <= boundary.seq
  )`

export const conversationMessagePredicate = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`
    ${ownMessagePredicate(sql)} AND
    (
      m.role = ${ROLE.user}
      OR
      (
        m.role = ${ROLE.interaction}
        AND (
          json_extract(m.message_json, '$.from.source') IN ('automation', 'agent', 'workflow')
          OR ${agentResultMessagePredicate(sql)}
          OR ${communicationDrawnSql(sql)}
        )
      )
      OR
      (
        m.role = ${ROLE.assistant}
        AND m.search_text IS NOT NULL
        AND json_extract(m.message_json, '$.compaction') IS NULL
      )
      OR
      (
        -- A call whose result is conversation content (a card, a proposal, a
        -- navigation request) keeps its carrier in the conversation stream
        -- even when it says nothing else.
        m.role = ${ROLE.assistant}
        AND json_extract(m.message_json, '$.compaction') IS NULL
        AND EXISTS (
          SELECT 1
          FROM json_each(m.message_json, '$.tool_calls') AS call
          WHERE ${conversationCallPredicate(sql)}
        )
      )
    )
  `

export const toolWorkCarrierMessagePredicate = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`
    ${ownMessagePredicate(sql)} AND
    (
      m.role = ${ROLE.assistant}
      AND (
        COALESCE(json_array_length(m.message_json, '$.provider_tool_calls'), 0) > 0
        OR EXISTS (
          SELECT 1
          FROM json_each(m.message_json, '$.tool_calls') AS call
          WHERE NOT ${conversationCallPredicate(sql)}
        )
      )
    )
  `

export const workCarrierMessagePredicate = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`
    ${ownMessagePredicate(sql)} AND
    (
      m.role = ${ROLE.assistant}
      AND json_extract(m.message_json, '$.superseded') IS NULL
      AND (
        length(trim(COALESCE(json_extract(m.message_json, '$.reasoning_content'), ''))) > 0
        OR COALESCE(json_array_length(m.message_json, '$.provider_tool_calls'), 0) > 0
        OR EXISTS (
          SELECT 1
          FROM json_each(m.message_json, '$.tool_calls') AS call
          WHERE NOT ${conversationCallPredicate(sql)}
        )
        OR EXISTS (
          SELECT 1
          FROM json_each(m.message_json, '$.output_parts') AS part
          WHERE json_extract(part.value, '$.type') = 'reasoning'
        )
      )
    )
  `

const communicationDrawnSql = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`(${communicationToldSql(sql)}
    AND COALESCE(json_extract(m.message_json, '$.communication.shown'), 1) <> 0)`
