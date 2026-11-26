import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { TranscriptMessageRecord } from "../transcript/model.js"
import {
  TranscriptQueryError,
  type TranscriptQueries,
  type TranscriptQueryFailure
} from "../transcript/queries.js"

export interface TranscriptRow {
  readonly session_id: string
  readonly message_id: string
  readonly seq: number
  readonly role: string
  readonly message_json: string
  readonly client_id: string | null
  readonly created_at: string
}

export const makeToolResultInSession = (
  sql: SqlClient.SqlClient,
  decodeRow: (row: TranscriptRow) => Effect.Effect<TranscriptMessageRecord, TranscriptQueryFailure>
): TranscriptQueries["Service"]["toolResultInSession"] =>
  Effect.fn("SqliteTranscriptQueries.toolResultInSession")(function* (
    sessionId: string,
    toolCallId: string
  ) {
    const needle = JSON.stringify(toolCallId)
    const rows = yield* sql<TranscriptRow>`
        SELECT session_id, message_id, seq, role, message_json, client_id, created_at
        FROM session_messages
        WHERE session_id = ${sessionId}
          AND ((role = ${ROLE.tool} AND instr(message_json, ${needle}) > 0
                AND json_extract(message_json, '$.tool_call_id') = ${toolCallId}
                AND json_extract(message_json, '$.async_tool_launch') IS NULL))
        ORDER BY seq DESC
        LIMIT 1
      `.pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptQueryError({
            operation: "resolve",
            sessionId,
            message: "Could not find the tool call's result",
            cause
          })
      )
    )
    const row = rows[0]
    return row === undefined ? null : yield* decodeRow(row)
  })
