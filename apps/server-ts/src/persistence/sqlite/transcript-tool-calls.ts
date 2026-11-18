import type { TurnToolCallCount } from "@arden-hq/protocol/chat"
import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { TranscriptQueryError, type TranscriptQueries } from "../transcript/queries.js"
import { messageTurnIdSql } from "./message-turns.js"

interface ToolCallCountRow {
  readonly turn_id: string
  readonly name: string
  readonly display_name: string | null
  readonly count: number
  readonly rejected: number
  /** The `seq` of each call's message, joined by commas, in no promised order. */
  readonly seqs: string
}

/** Which tools each turn called, how often, and where in the chat each call sits.
 *  `conversationCall` is the predicate over `call.value` for a call whose result is
 *  conversation content: such a call is not counted as work. */
export const makeToolCallCounts = (
  sql: SqlClient.SqlClient,
  conversationCall: Statement.Fragment
): TranscriptQueries["Service"]["toolCallCounts"] =>
  Effect.fn("SqliteTranscriptQueries.toolCallCounts")(function* (sessionId, turnIds) {
    const counts = new Map<string, Array<TurnToolCallCount>>()
    if (turnIds.length === 0) return counts
    // CROSS JOIN keeps session_turns outermost, so each turn reads only its
    // own (session_id, seq) range. With a plain JOIN SQLite drove the query
    // from the transcript and parsed every message of the chat twice: 160 ms
    // instead of 5 ms on a 22k-message chat.
    const rows = yield* sql<ToolCallCountRow>`
      SELECT turn_id, name, display_name, COUNT(*) AS count, SUM(rejected) AS rejected,
             group_concat(seq) AS seqs
      FROM (
        SELECT t.turn_id AS turn_id,
               json_extract(call.value, '$.function.name') AS name,
               json_extract(call.value, '$.display_name') AS display_name,
               m.seq AS seq,
               EXISTS (
                 SELECT 1
                 FROM tool_approvals AS a
                 WHERE a.session_id = t.session_id
                   AND a.tool_call_id = json_extract(call.value, '$.id')
                   AND a.kind = 'tool_approval'
                   AND a.status = 'rejected'
               ) AS rejected
        FROM session_turns AS t
        CROSS JOIN session_messages AS m
          ON m.session_id = t.session_id
         AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
        JOIN json_each(m.message_json, '$.tool_calls') AS call
        WHERE t.session_id = ${sessionId}
          AND t.turn_id IN ${sql.in(turnIds)}
          AND m.role = 'assistant'
          AND ${messageTurnIdSql(sql, "m")} = t.turn_id
          AND NOT ${conversationCall}
        UNION ALL
        SELECT t.turn_id,
               json_extract(call.value, '$.name'),
               NULL,
               m.seq,
               0
        FROM session_turns AS t
        CROSS JOIN session_messages AS m
          ON m.session_id = t.session_id
         AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
        JOIN json_each(m.message_json, '$.provider_tool_calls') AS call
        WHERE t.session_id = ${sessionId}
          AND t.turn_id IN ${sql.in(turnIds)}
          AND m.role = 'assistant'
          AND ${messageTurnIdSql(sql, "m")} = t.turn_id
      )
      WHERE name IS NOT NULL
      GROUP BY turn_id, name, display_name
      ORDER BY turn_id, MIN(seq), name
    `.pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptQueryError({
            operation: "page",
            sessionId,
            message: "Could not count turn tool calls",
            cause
          })
      )
    )
    for (const row of rows) {
      const list = counts.get(row.turn_id) ?? []
      list.push({
        name: row.name,
        display_name: row.display_name,
        count: row.count,
        rejected: row.rejected,
        seqs: row.seqs
          .split(",")
          .map(Number)
          .sort((left, right) => left - right)
      })
      counts.set(row.turn_id, list)
    }
    return counts
  })
