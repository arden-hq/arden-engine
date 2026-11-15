import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { TranscriptPageQuerySchema, type TranscriptMessageRecord } from "../transcript/model.js"
import {
  TranscriptQueryError,
  type TranscriptQueries,
  type TranscriptQueryFailure
} from "../transcript/queries.js"
import type { TranscriptRow } from "./transcript-tool-result.js"

/**
 * The one test for "the owner's own words", over the `session_messages` row `m`: a user
 * message with none of the marks other writers leave, proven by what is stored beside it. A
 * message the owner typed belongs to a turn whose run started from the chat, here or in the chat
 * a branch copied it from. An answer to Arden's question names a question that holds a
 * resolution, which only the owner writes: the question routes and a typed reply.
 */
export const ownerWordsSql = (
  sql: SqlClient.SqlClient,
  m: Statement.Fragment
): Statement.Fragment => sql`(
  ${m}.role = 'user'
  AND json_extract(${m}.message_json, '$.interaction') IS NULL
  AND json_extract(${m}.message_json, '$.from_chat') IS NULL
  AND json_extract(${m}.message_json, '$.forked_from') IS NULL
  AND json_extract(${m}.message_json, '$.sent_from') IS NULL
  AND json_extract(${m}.message_json, '$.automation') IS NULL
  AND CASE WHEN json_extract(${m}.message_json, '$.is_meta') = 1
    THEN EXISTS (SELECT 1 FROM run_questions AS question
      WHERE question.question_id = json_extract(${m}.message_json, '$.question_answer.question_id')
        AND question.resolution IS NOT NULL)
    ELSE EXISTS (SELECT 1 FROM chat_runs AS run
      WHERE run.session_id IN (${m}.session_id, (SELECT json_extract(branch.metadata,
          '$.fork_origin.sourceSessionId') FROM sessions AS branch
          WHERE branch.session_id = ${m}.session_id))
        AND json_extract(run.metadata_json, '$.turn_id')
          = COALESCE(json_extract(${m}.message_json, '$.turn_id'), ${m}.message_id)
        AND json_extract(run.metadata_json, '$.run_context.origin.kind') = 'chat')
  END)`

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
      FROM session_messages AS message
      WHERE session_id = ${query.sessionId} AND seq > ${input.sequence}
        AND ${ownerWordsSql(sql, sql`message`)}
      ORDER BY seq ASC LIMIT ${query.limit}
    `.pipe(Effect.mapError(failure(input.sessionId, "Could not read owner messages")))
    return yield* Effect.forEach(rows, decodeRow)
  })
