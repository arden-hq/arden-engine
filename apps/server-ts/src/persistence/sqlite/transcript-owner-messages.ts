import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { TranscriptPageQuerySchema, type TranscriptMessageRecord } from "../transcript/model.js"
import {
  TranscriptQueryError,
  type TranscriptQueries,
  type TranscriptQueryFailure
} from "../transcript/queries.js"
import type { TranscriptRow } from "./transcript-tool-result.js"

const genuineOwner = (sql: SqlClient.SqlClient) => sql`
  role = 'user'
  AND json_extract(message_json, '$.interaction') IS NULL
  AND json_extract(message_json, '$.from_chat') IS NULL
  AND json_extract(message_json, '$.forked_from') IS NULL
  AND json_extract(message_json, '$.sent_from') IS NULL
  AND json_extract(message_json, '$.automation') IS NULL
  AND (COALESCE(json_extract(message_json, '$.is_meta'), 0) <> 1
    OR json_extract(message_json, '$.question_answer') IS NOT NULL)
`

export const makeOwnerMessagesAfter = (
  sql: SqlClient.SqlClient,
  decodeRow: (row: TranscriptRow) => Effect.Effect<TranscriptMessageRecord, TranscriptQueryFailure>
): TranscriptQueries["Service"]["ownerMessagesAfter"] =>
  Effect.fn("SqliteTranscriptQueries.ownerMessagesAfter")(function* (input) {
    const query = yield* Schema.decodeUnknownEffect(TranscriptPageQuerySchema)({
      _tag: "After",
      ...input
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptQueryError({
            operation: "page",
            sessionId: input.sessionId,
            message: "Invalid owner-message query",
            cause
          })
      )
    )
    const rows = yield* sql<TranscriptRow>`
      SELECT session_id, message_id, seq, role, message_json, client_id, created_at
      FROM session_messages
      WHERE session_id = ${query.sessionId} AND seq > ${input.sequence} AND ${genuineOwner(sql)}
      ORDER BY seq ASC LIMIT ${query.limit}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptQueryError({
            operation: "page",
            sessionId: input.sessionId,
            message: "Could not read owner messages",
            cause
          })
      )
    )
    return yield* Effect.forEach(rows, decodeRow)
  })
