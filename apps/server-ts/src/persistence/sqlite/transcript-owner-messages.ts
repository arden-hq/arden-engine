import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { TranscriptPageQuerySchema, type TranscriptMessageRecord } from "../transcript/model.js"
import {
  TranscriptQueryError,
  type TranscriptQueries,
  type TranscriptQueryFailure
} from "../transcript/queries.js"
import type { TranscriptRow } from "./transcript-tool-result.js"

export const ownerWordsSql = (
  sql: SqlClient.SqlClient,
  m: Statement.Fragment
): Statement.Fragment => sql`${m}.author IN ('owner', 'answer')`

const failure = (sessionId: string, message: string) => (cause: unknown) =>
  new TranscriptQueryError({ operation: "page", sessionId, message, cause })

export const makeOwnerWordsIn =
  (sql: SqlClient.SqlClient): TranscriptQueries["Service"]["ownerWordsIn"] =>
  (sessionId, messageIds) =>
    messageIds.length === 0
      ? Effect.succeed(new Set())
      : sql<{ readonly message_id: string }>`
      SELECT message.message_id FROM session_messages AS message
      WHERE message.session_id = ${sessionId} AND message.message_id IN ${sql.in(messageIds)}
        AND ${ownerWordsSql(sql, sql`message`)}
    `.pipe(
          Effect.map((rows) => new Set(rows.map((row) => row.message_id))),
          Effect.mapError(failure(sessionId, "Could not read the owner's words"))
        )

export const makeOwnerMessagesAfter = (
  sql: SqlClient.SqlClient,
  decodeRow: (row: TranscriptRow) => Effect.Effect<TranscriptMessageRecord, TranscriptQueryFailure>
): TranscriptQueries["Service"]["ownerMessagesAfter"] =>
  Effect.fn("SqliteTranscriptQueries.ownerMessagesAfter")(function* (input) {
    const query = yield* Schema.decodeUnknownEffect(TranscriptPageQuerySchema)({
      _tag: "After",
      ...input
    }).pipe(Effect.mapError(failure(input.sessionId, "Invalid owner-message query")))
    const rows = yield* sql<TranscriptRow>`
      SELECT session_id, message_id, seq, role, message_json, client_id, created_at
      FROM session_messages AS message
      WHERE session_id = ${query.sessionId} AND seq > ${input.sequence}
        AND ${ownerWordsSql(sql, sql`message`)}
      ORDER BY seq ASC LIMIT ${query.limit}
    `.pipe(Effect.mapError(failure(input.sessionId, "Could not read owner messages")))
    return yield* Effect.forEach(rows, decodeRow)
  })
