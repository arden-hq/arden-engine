import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { TranscriptMessageRecord } from "../transcript/model.js"
import {
  TranscriptQueryError,
  type TranscriptQueries,
  type TranscriptQueryFailure
} from "../transcript/queries.js"
import { messageTurnIdSql } from "./message-turns.js"
import type { TranscriptRow } from "./transcript-tool-result.js"

export const makeTurnInputs = ({
  sql,
  decodeRow
}: {
  readonly sql: SqlClient.SqlClient
  readonly decodeRow: (
    row: TranscriptRow
  ) => Effect.Effect<TranscriptMessageRecord, TranscriptQueryFailure>
}): TranscriptQueries["Service"]["turnInputs"] =>
  Effect.fn("SqliteTranscriptQueries.turnInputs")(function* ({ sessionId, turnId }) {
    const rows = yield* sql<TranscriptRow>`
      SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
             m.client_id, m.created_at
      FROM session_messages AS m
      WHERE m.session_id = ${sessionId}
        AND ${messageTurnIdSql(sql, "m")} = ${turnId}
        AND m.role = 'user'
        AND json_extract(m.message_json, '$.superseded') IS NULL
        AND (m.message_id = ${turnId}
          OR json_extract(m.message_json, '$.applied_at') IS NOT NULL)
      ORDER BY m.seq ASC
    `.pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptQueryError({
            operation: "page",
            sessionId,
            message: "Could not read accepted turn inputs",
            cause
          })
      )
    )
    return (yield* Effect.forEach(rows, decodeRow)).map((record) => record.envelope)
  })
