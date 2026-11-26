import { Effect, Schema } from "effect"
import { type TranscriptRow } from "./transcript-tool-result.js"
import {
  TranscriptDataCorruptionError,
  TranscriptQueryError,
  type TranscriptQueries
} from "../transcript/queries.js"
import {
  TranscriptPageSchema,
  TranscriptTurnWorkPageQuerySchema,
  type TranscriptTurnWorkPageQuery
} from "../transcript/model.js"
import type { PersistenceDeps } from "./deps.js"
import { messageTurnIdSql } from "./message-turns.js"
import { workCarrierMessagePredicate } from "./transcript-predicates.js"
import type { makeDecodeRow } from "./transcript-rows.js"
import { type SequenceRow, corruption, queryError } from "./transcript-rows.js"

export interface TurnWorkReads {
  readonly resolveTurnWorkReference: TranscriptQueries["Service"]["resolveTurnWorkReference"]
  readonly turnWorkPage: TranscriptQueries["Service"]["turnWorkPage"]
}

export const makeTurnWorkReads = ({
  sql,
  workCarrierPredicate,
  decodeRow
}: {
  readonly sql: PersistenceDeps["reader"]
  readonly workCarrierPredicate: ReturnType<typeof workCarrierMessagePredicate>
  readonly decodeRow: ReturnType<typeof makeDecodeRow>
}): TurnWorkReads => {
  const resolveTurnWorkReference = Effect.fn("SqliteTranscriptQueries.resolveTurnWorkReference")(
    function* (sessionId: string, turnId: string, messageId: string) {
      const rows = yield* sql<SequenceRow>`
      SELECT m.seq
      FROM session_turns AS t
      JOIN session_messages AS m
        ON m.session_id = t.session_id
        AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
      WHERE t.session_id = ${sessionId}
        AND t.turn_id = ${turnId}
        AND m.message_id = ${messageId}
        AND ${messageTurnIdSql(sql, "m")} = ${turnId}
        AND ${workCarrierPredicate}
      LIMIT 1
    `.pipe(
        Effect.mapError((cause) =>
          queryError("resolve", sessionId, "Could not resolve turn-work cursor", cause)
        )
      )
      return rows[0]?.seq ?? null
    }
  )

  const turnWorkPageRaw = Effect.fn("SqliteTranscriptQueries.turnWorkPage")(function* (
    input: TranscriptTurnWorkPageQuery
  ) {
    const query = yield* Schema.decodeUnknownEffect(TranscriptTurnWorkPageQuerySchema)(input).pipe(
      Effect.mapError((cause) =>
        queryError("page", input.sessionId, "Invalid turn-work page query", cause)
      )
    )
    const pageRows = (): Effect.Effect<ReadonlyArray<TranscriptRow>, unknown> => {
      if (TranscriptTurnWorkPageQuerySchema.guards.Latest(query)) {
        return sql<TranscriptRow>`
          SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                 m.client_id, m.created_at
          FROM session_turns AS t
          JOIN session_messages AS m
            ON m.session_id = t.session_id
            AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
          WHERE t.session_id = ${query.sessionId}
            AND t.turn_id = ${query.turnId}
            AND ${messageTurnIdSql(sql, "m")} = ${query.turnId}
            AND ${workCarrierPredicate}
          ORDER BY m.seq DESC
          LIMIT ${query.limit}
        `.pipe(Effect.map((items) => Array.from(items).reverse()))
      }
      if (TranscriptTurnWorkPageQuerySchema.guards.After(query)) {
        return sql<TranscriptRow>`
          SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                 m.client_id, m.created_at
          FROM session_turns AS t
          JOIN session_messages AS m
            ON m.session_id = t.session_id
            AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
          WHERE t.session_id = ${query.sessionId}
            AND t.turn_id = ${query.turnId}
            AND m.seq > ${query.sequence}
            AND ${messageTurnIdSql(sql, "m")} = ${query.turnId}
            AND ${workCarrierPredicate}
          ORDER BY m.seq ASC
          LIMIT ${query.limit}
        `
      }
      return sql<TranscriptRow>`
          SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                 m.client_id, m.created_at
          FROM session_turns AS t
          JOIN session_messages AS m
            ON m.session_id = t.session_id
            AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
          WHERE t.session_id = ${query.sessionId}
            AND t.turn_id = ${query.turnId}
            AND m.seq < ${query.sequence}
            AND ${messageTurnIdSql(sql, "m")} = ${query.turnId}
            AND ${workCarrierPredicate}
          ORDER BY m.seq DESC
          LIMIT ${query.limit}
        `.pipe(Effect.map((items) => Array.from(items).reverse()))
    }
    const rows = yield* pageRows()
    const records = yield* Effect.forEach(rows, decodeRow)
    const firstSequence = records[0]?.sequence ?? null
    const lastSequence = records[records.length - 1]?.sequence ?? null
    const hasMoreBefore =
      firstSequence === null
        ? false
        : (yield* sql<SequenceRow>`
          SELECT m.seq
          FROM session_turns AS t
          JOIN session_messages AS m
            ON m.session_id = t.session_id
            AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
          WHERE t.session_id = ${query.sessionId}
            AND t.turn_id = ${query.turnId}
            AND m.seq < ${firstSequence}
            AND ${messageTurnIdSql(sql, "m")} = ${query.turnId}
            AND ${workCarrierPredicate}
          LIMIT 1
        `).length > 0
    const hasMoreAfter =
      lastSequence === null
        ? false
        : (yield* sql<SequenceRow>`
          SELECT m.seq
          FROM session_turns AS t
          JOIN session_messages AS m
            ON m.session_id = t.session_id
            AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
          WHERE t.session_id = ${query.sessionId}
            AND t.turn_id = ${query.turnId}
            AND m.seq > ${lastSequence}
            AND ${messageTurnIdSql(sql, "m")} = ${query.turnId}
            AND ${workCarrierPredicate}
          LIMIT 1
        `).length > 0

    return yield* Schema.decodeUnknownEffect(TranscriptPageSchema)({
      records,
      hasMoreBefore,
      hasMoreAfter,
      firstSequence,
      lastSequence
    }).pipe(
      Effect.mapError((cause) => corruption(query.sessionId, "Turn-work page is corrupt", cause))
    )
  })

  const turnWorkPage = (input: TranscriptTurnWorkPageQuery) =>
    turnWorkPageRaw(input).pipe(
      Effect.mapError((cause) =>
        cause instanceof TranscriptQueryError || cause instanceof TranscriptDataCorruptionError
          ? cause
          : queryError("page", input.sessionId, "Could not read turn-work page", cause)
      )
    )
  return { resolveTurnWorkReference, turnWorkPage }
}
