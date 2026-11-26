import { RunOriginSchema } from "../runs/stored-context.js"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { makeTurnInputs } from "./transcript-turn-inputs.js"
import { makeResolveReference } from "./transcript-reference.js"
import { makeOwnerMessagesAfter, makeOwnerWordsIn } from "./transcript-owner-messages.js"
import { TRANSCRIPT_RESULT_PREVIEW_CHARS } from "../transcript/model.js"
import { Effect, Schema } from "effect"
import { makeTranscriptSearches } from "./transcript-search.js"
import { makeToolResultInSession, type TranscriptRow } from "./transcript-tool-result.js"
import { makeToolCallCounts } from "./transcript-tool-calls.js"
import {
  TRANSCRIPT_RESULT_VIEW,
  TranscriptDataCorruptionError,
  TranscriptQueries,
  TranscriptQueryError,
  type TranscriptResultView
} from "../transcript/queries.js"
import {
  TranscriptPageSchema,
  TranscriptPageQuerySchema,
  type TranscriptPageQuery
} from "../transcript/model.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"
import { messageTurnIdSql } from "./message-turns.js"
import {
  conversationCallPredicate,
  workCarrierMessagePredicate,
  toolWorkCarrierMessagePredicate,
  conversationMessagePredicate
} from "./transcript-predicates.js"
import { makeDecodeRow } from "./transcript-rows.js"
import { makePage } from "./transcript-page.js"
import { makeTurnWorkReads } from "./transcript-turn-work.js"
import {
  type CountRow,
  type SequenceRow,
  type TurnIdRow,
  type TurnOriginRow,
  corruption,
  queryError
} from "./transcript-rows.js"

export const makeTranscriptQueries = ({
  reader,
  writer
}: Pick<PersistenceDeps, "reader" | "writer">): TranscriptQueries["Service"] => {
  const sql = reader
  const conversationPredicate = conversationMessagePredicate(sql)
  const workCarrierPredicate = workCarrierMessagePredicate(sql)
  const toolWorkCarrierPredicate = toolWorkCarrierMessagePredicate(sql)

  const decodeRow = makeDecodeRow(sql)
  const resolveReference = makeResolveReference(sql)

  const resolveConversationReference = Effect.fn(
    "SqliteTranscriptQueries.resolveConversationReference"
  )(function* (sessionId: string, messageOrClientId: string) {
    const rows = yield* sql<SequenceRow>`
      SELECT m.seq
      FROM session_messages AS m
      WHERE m.session_id = ${sessionId}
        AND (m.message_id = ${messageOrClientId} OR m.client_id = ${messageOrClientId})
        AND ${conversationPredicate}
      ORDER BY m.seq DESC
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        queryError("resolve", sessionId, "Could not resolve conversation cursor", cause)
      )
    )
    return rows[0]?.seq ?? null
  })

  const page = makePage({ sql, decodeRow })
  const conversationAround = Effect.fn("SqliteTranscriptQueries.conversationAround")(function* (
    query: Extract<TranscriptPageQuery, { readonly _tag: "Around" }>
  ) {
    const counts = yield* sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM session_messages AS m
      WHERE m.session_id = ${query.sessionId} AND ${conversationPredicate}
    `
    const beforeCounts = yield* sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM session_messages AS m
      WHERE m.session_id = ${query.sessionId}
        AND m.seq <= ${query.sequence}
        AND ${conversationPredicate}
    `
    const total = counts[0]?.count ?? 0
    const beforeCount = beforeCounts[0]?.count ?? 0
    const centered = Math.max(0, beforeCount - Math.floor(query.limit / 2) - 1)
    const offset = Math.min(centered, Math.max(0, total - query.limit))
    return yield* sql<TranscriptRow>`
      SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
             m.client_id, m.created_at
      FROM session_messages AS m
      WHERE m.session_id = ${query.sessionId} AND ${conversationPredicate}
      ORDER BY m.seq ASC
      LIMIT ${query.limit} OFFSET ${offset}
    `
  })

  const conversationPageRaw = Effect.fn("SqliteTranscriptQueries.conversationPage")(function* (
    input: TranscriptPageQuery
  ) {
    const query = yield* Schema.decodeUnknownEffect(TranscriptPageQuerySchema)(input).pipe(
      Effect.mapError((cause) =>
        queryError("page", input.sessionId, "Invalid conversation page query", cause)
      )
    )
    const rows: ReadonlyArray<TranscriptRow> = yield* TranscriptPageQuerySchema.match(query, {
      Latest: (query) =>
        sql<TranscriptRow>`
            SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                   m.client_id, m.created_at
            FROM session_messages AS m
            WHERE m.session_id = ${query.sessionId} AND ${conversationPredicate}
            ORDER BY m.seq DESC
            LIMIT ${query.limit}
          `.pipe(Effect.map((items) => Array.from(items).reverse())),
      Before: (query) =>
        sql<TranscriptRow>`
            SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                   m.client_id, m.created_at
            FROM session_messages AS m
            WHERE m.session_id = ${query.sessionId}
              AND m.seq < ${query.sequence}
              AND ${conversationPredicate}
            ORDER BY m.seq DESC
            LIMIT ${query.limit}
          `.pipe(Effect.map((items) => Array.from(items).reverse())),
      After: (query) =>
        sql<TranscriptRow>`
            SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                   m.client_id, m.created_at
            FROM session_messages AS m
            WHERE m.session_id = ${query.sessionId}
              AND m.seq > ${query.sequence}
              AND ${conversationPredicate}
            ORDER BY m.seq ASC
            LIMIT ${query.limit}
          `,
      Around: conversationAround
    })

    const records = yield* Effect.forEach(rows, decodeRow)
    const firstSequence = records[0]?.sequence ?? null
    const lastSequence = records[records.length - 1]?.sequence ?? null
    const hasMoreBefore =
      firstSequence === null
        ? false
        : (yield* sql<SequenceRow>`
          SELECT m.seq
          FROM session_messages AS m
          WHERE m.session_id = ${query.sessionId}
            AND m.seq < ${firstSequence}
            AND ${conversationPredicate}
          LIMIT 1
        `).length > 0
    const hasMoreAfter =
      lastSequence === null
        ? false
        : (yield* sql<SequenceRow>`
          SELECT m.seq
          FROM session_messages AS m
          WHERE m.session_id = ${query.sessionId}
            AND m.seq > ${lastSequence}
            AND ${conversationPredicate}
          LIMIT 1
        `).length > 0

    return yield* Schema.decodeUnknownEffect(TranscriptPageSchema)({
      records,
      hasMoreBefore,
      hasMoreAfter,
      firstSequence,
      lastSequence
    }).pipe(
      Effect.mapError((cause) => corruption(query.sessionId, "Conversation page is corrupt", cause))
    )
  })

  const conversationPage = (input: TranscriptPageQuery) =>
    conversationPageRaw(input).pipe(
      Effect.mapError((cause) =>
        cause instanceof TranscriptQueryError || cause instanceof TranscriptDataCorruptionError
          ? cause
          : queryError("page", input.sessionId, "Could not read conversation page", cause)
      )
    )

  const { resolveTurnWorkReference, turnWorkPage } = makeTurnWorkReads({
    sql,
    workCarrierPredicate,
    decodeRow
  })
  const toolCallCarrier = Effect.fn("SqliteTranscriptQueries.toolCallCarrier")(function* (
    sessionId: string,
    turnId: string,
    toolCallId: string
  ) {
    const needle = `"id":${JSON.stringify(toolCallId)}`
    const rows = yield* sql<TranscriptRow>`
        SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
               m.client_id, m.created_at
        FROM session_turns AS t
        JOIN session_messages AS m
          ON m.session_id = t.session_id
          AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
        WHERE t.session_id = ${sessionId}
          AND t.turn_id = ${turnId}
          AND m.role = ${ROLE.assistant}
          AND ${messageTurnIdSql(sql, "m")} = ${turnId}
          AND instr(json_extract(m.message_json, '$.tool_calls'), ${needle}) > 0
        ORDER BY m.seq ASC
        LIMIT 1
      `.pipe(
      Effect.mapError((cause) =>
        queryError("resolve", sessionId, "Could not find the tool call's carrier", cause)
      )
    )
    const row = rows[0]
    if (row === undefined) return null
    return yield* decodeRow(row).pipe(
      Effect.mapError((cause) =>
        cause instanceof TranscriptDataCorruptionError
          ? cause
          : queryError("resolve", sessionId, "Could not decode the tool call's carrier", cause)
      )
    )
  })
  const toolResultsFor = Effect.fn("SqliteTranscriptQueries.toolResultsFor")(function* (
    sessionId: string,
    turnIds: ReadonlyArray<string>,
    toolCallIds: ReadonlyArray<string>,
    view: TranscriptResultView = TRANSCRIPT_RESULT_VIEW.full
  ) {
    if (turnIds.length === 0 || toolCallIds.length === 0) return []
    const content = sql`json_extract(m.message_json, '$.content')`
    const messageJson =
      view === TRANSCRIPT_RESULT_VIEW.compact
        ? sql`
        CASE WHEN json_type(m.message_json, '$.content') = 'text' AND length(${content}) > ${TRANSCRIPT_RESULT_PREVIEW_CHARS}
        THEN json_set(m.message_json, '$.content', substr(${content}, 1, ${TRANSCRIPT_RESULT_PREVIEW_CHARS}) || '…', '$.compact', json('true'))
        ELSE m.message_json END
      `
        : sql`m.message_json`
    const rows = yield* sql<TranscriptRow>`
        SELECT m.session_id, m.message_id, m.seq, m.role, ${messageJson} AS message_json,
               m.client_id, m.created_at
        FROM session_turns AS t
        JOIN session_messages AS m
          ON m.session_id = t.session_id
          AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
        WHERE t.session_id = ${sessionId}
          AND t.turn_id IN ${sql.in(turnIds)}
          AND ${messageTurnIdSql(sql, "m")} = t.turn_id
          AND ((m.role = ${ROLE.tool} AND json_extract(m.message_json, '$.async_tool_launch') IS NULL
                AND json_extract(m.message_json, '$.tool_call_id') IN ${sql.in(toolCallIds)}))
        ORDER BY m.seq ASC
      `.pipe(
      Effect.mapError((cause) =>
        queryError("page", sessionId, "Could not hydrate turn-work results", cause)
      )
    )
    return yield* Effect.forEach(rows, decodeRow)
  })

  const turnIdsCarrying = (carrier: typeof workCarrierPredicate, label: string) =>
    Effect.fn(label)(function* (sessionId: string, turnIds: ReadonlyArray<string>) {
      if (turnIds.length === 0) return new Set<string>()
      const rows = yield* sql<TurnIdRow>`
        SELECT DISTINCT t.turn_id
        FROM session_turns AS t
        WHERE t.session_id = ${sessionId}
          AND t.turn_id IN ${sql.in(turnIds)}
          AND EXISTS (
            SELECT 1
            FROM session_messages AS m
            WHERE m.session_id = t.session_id
              AND m.seq BETWEEN t.message_start_seq AND t.message_end_seq
              AND ${messageTurnIdSql(sql, "m")} = t.turn_id
              AND ${carrier}
          )
      `.pipe(
        Effect.mapError((cause) =>
          queryError("page", sessionId, "Could not inspect turn work", cause)
        )
      )
      return new Set(rows.map((row) => row.turn_id))
    })
  const turnIdsWithWork = turnIdsCarrying(
    workCarrierPredicate,
    "SqliteTranscriptQueries.turnIdsWithWork"
  )
  const turnIdsWithToolWork = turnIdsCarrying(
    toolWorkCarrierPredicate,
    "SqliteTranscriptQueries.turnIdsWithToolWork"
  )

  const originsForTurns = Effect.fn("SqliteTranscriptQueries.originsForTurns")(function* (
    sessionId: string,
    turnIds: ReadonlyArray<string>
  ) {
    if (turnIds.length === 0) return new Map()
    const rows = yield* sql<TurnOriginRow>`
        SELECT json_extract(metadata_json, '$.turn_id') AS turn_id,
               json_extract(metadata_json, '$.run_context.origin') AS origin_json
        FROM chat_runs
        WHERE session_id = ${sessionId}
          AND json_extract(metadata_json, '$.turn_id') IN ${sql.in(turnIds)}
        ORDER BY started_at, run_id
      `.pipe(
      Effect.mapError((cause) =>
        queryError("page", sessionId, "Could not read transcript turn origins", cause)
      )
    )
    const origins = new Map<string, typeof RunOriginSchema.Type>()
    for (const row of rows) {
      const origin = yield* decodeJson(RunOriginSchema, row.origin_json).pipe(
        Effect.mapError((cause) =>
          corruption(sessionId, "Transcript turn origin is corrupt", cause)
        )
      )
      const existing = origins.get(row.turn_id)
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(origin)) {
        return yield* corruption(sessionId, "Transcript turn has conflicting durable origins")
      }
      origins.set(row.turn_id, origin)
    }
    return origins
  })

  return TranscriptQueries.of({
    turnInputs: makeTurnInputs({ sql, decodeRow }),
    ownerMessagesAfter: makeOwnerMessagesAfter(sql, decodeRow),
    ownerWordsIn: makeOwnerWordsIn(sql),
    resolveReference,
    page,
    resolveConversationReference,
    conversationPage,
    resolveTurnWorkReference,
    toolCallCarrier,
    turnWorkPage,
    toolResultsFor,
    toolResultInSession: makeToolResultInSession(sql, decodeRow),
    turnIdsWithWork,
    turnIdsWithToolWork,
    toolCallCounts: makeToolCallCounts(sql, conversationCallPredicate(sql)),
    originsForTurns,
    ...makeTranscriptSearches(sql, writer.sql, conversationMessagePredicate)
  })
}
