import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { TranscriptQueryError, type TranscriptQueries } from "../transcript/queries.js"

export const makeResolveReference = (
  sql: SqlClient.SqlClient
): TranscriptQueries["Service"]["resolveReference"] => {
  return Effect.fn("SqliteTranscriptQueries.resolveReference")(function* (
    sessionId: string,
    messageOrClientId: string
  ) {
    const rows = yield* sql<{ readonly seq: number }>`
      SELECT seq
      FROM (
        SELECT seq, 0 AS priority FROM session_messages
        WHERE session_id = ${sessionId}
          AND (message_id = ${messageOrClientId} OR client_id = ${messageOrClientId})
        UNION ALL
        SELECT message_start_seq AS seq, 1 AS priority FROM session_turns
        WHERE session_id = ${sessionId} AND turn_id = ${messageOrClientId}
      )
      ORDER BY priority, seq DESC
      LIMIT 1
    `.pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptQueryError({
            operation: "resolve",
            sessionId,
            message: "Could not resolve message reference",
            cause
          })
      )
    )
    return rows[0]?.seq ?? null
  })
}
