import { Effect, Schema } from "effect"
import { type TranscriptRow } from "./transcript-tool-result.js"
import {
  TranscriptDataCorruptionError,
  TranscriptQueryError,
  type TranscriptQueries
} from "../transcript/queries.js"
import {
  TranscriptPageSchema,
  TranscriptPageQuerySchema,
  type TranscriptPageQuery
} from "../transcript/model.js"
import type { PersistenceDeps } from "./deps.js"
import type { makeDecodeRow } from "./transcript-rows.js"
import { corruption, queryError } from "./transcript-rows.js"

export const makePage = ({
  sql,
  decodeRow
}: {
  readonly sql: PersistenceDeps["reader"]
  readonly decodeRow: ReturnType<typeof makeDecodeRow>
}): TranscriptQueries["Service"]["page"] => {
  const pageRaw = Effect.fn("SqliteTranscriptQueries.page")(function* (input: TranscriptPageQuery) {
    const query = yield* Schema.decodeUnknownEffect(TranscriptPageQuerySchema)(input).pipe(
      Effect.mapError((cause) =>
        queryError("page", input.sessionId, "Invalid transcript page query", cause)
      )
    )
    const rows: ReadonlyArray<TranscriptRow> = yield* TranscriptPageQuerySchema.match(query, {
      Latest: (query) =>
        sql<TranscriptRow>`
          SELECT session_id, message_id, seq, role, message_json, client_id, created_at
          FROM session_messages
          WHERE session_id = ${query.sessionId}
          ORDER BY seq DESC
          LIMIT ${query.limit}
        `.pipe(Effect.map((items) => Array.from(items).reverse())),
      Before: (query) =>
        sql<TranscriptRow>`
          SELECT session_id, message_id, seq, role, message_json, client_id, created_at
          FROM session_messages
          WHERE session_id = ${query.sessionId} AND seq < ${query.sequence}
          ORDER BY seq DESC
          LIMIT ${query.limit}
        `.pipe(Effect.map((items) => Array.from(items).reverse())),
      After: (query) =>
        sql<TranscriptRow>`
          SELECT session_id, message_id, seq, role, message_json, client_id, created_at
          FROM session_messages
          WHERE session_id = ${query.sessionId} AND seq > ${query.sequence}
          ORDER BY seq ASC
          LIMIT ${query.limit}
        `,
      Around: (query) =>
        sql<TranscriptRow>`
          SELECT session_id, message_id, seq, role, message_json, client_id, created_at
          FROM session_messages
          WHERE session_id = ${query.sessionId}
            AND seq >= ${Math.max(0, query.sequence - Math.floor(query.limit / 2))}
          ORDER BY seq ASC
          LIMIT ${query.limit}
        `
    })

    const records = yield* Effect.forEach(rows, decodeRow)
    const firstSequence = records[0]?.sequence ?? null
    const lastSequence = records[records.length - 1]?.sequence ?? null
    const hasMoreBefore =
      firstSequence === null
        ? false
        : (yield* sql<{ readonly present: number }>`
        SELECT 1 AS present FROM session_messages
        WHERE session_id = ${query.sessionId} AND seq < ${firstSequence}
        LIMIT 1
      `).length > 0
    const hasMoreAfter =
      lastSequence === null
        ? false
        : (yield* sql<{ readonly present: number }>`
        SELECT 1 AS present FROM session_messages
        WHERE session_id = ${query.sessionId} AND seq > ${lastSequence}
        LIMIT 1
      `).length > 0

    return yield* Schema.decodeUnknownEffect(TranscriptPageSchema)({
      records,
      hasMoreBefore,
      hasMoreAfter,
      firstSequence,
      lastSequence
    }).pipe(
      Effect.mapError((cause) => corruption(query.sessionId, "Transcript page is corrupt", cause))
    )
  })

  const page = (input: TranscriptPageQuery) =>
    pageRaw(input).pipe(
      Effect.mapError((cause) =>
        cause instanceof TranscriptQueryError || cause instanceof TranscriptDataCorruptionError
          ? cause
          : queryError("page", input.sessionId, "Could not read transcript page", cause)
      )
    )
  return page
}
