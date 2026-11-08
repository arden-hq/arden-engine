import { makeTurnInputs } from "./transcript-turn-inputs.js"
import { makeResolveReference } from "./transcript-reference.js"
import { disposableForkSql } from "../schema/fork-disposition.js"
import { makeOwnerMessagesAfter } from "./transcript-owner-messages.js"
import {
  agentResultPresentation,
  agentResultMessagePredicate
} from "./agent-result-presentation.js"
import { TRANSCRIPT_RESULT_PREVIEW_CHARS } from "../transcript/model.js"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { makeTranscriptSearches } from "./transcript-search.js"
import { makeToolResultInSession, type TranscriptRow } from "./transcript-tool-result.js"
import { questionAnswerPredicate } from "./steered-answer.js"
import { RunOriginSchema } from "@arden-hq/protocol/effect/runs"
import {
  TranscriptDataCorruptionError,
  TranscriptQueries,
  TranscriptQueryError
} from "../transcript/queries.js"
import {
  asToolResultRecord,
  asyncResultClientId,
  TranscriptMessageRecordSchema,
  TranscriptPageSchema,
  TranscriptPageQuerySchema,
  TranscriptTurnWorkPageQuerySchema,
  StoredMessageEnvelopeSchema,
  type TranscriptPageQuery,
  type TranscriptTurnWorkPageQuery
} from "../transcript/model.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"
import type { TurnToolCallCount } from "@arden-hq/protocol/chat"
import { messageTurnIdSql } from "./message-turns.js"

interface CountRow {
  readonly count: number
}

interface SequenceRow {
  readonly seq: number
}

interface TurnIdRow {
  readonly turn_id: string
}

interface ToolCallCountRow {
  readonly turn_id: string
  readonly name: string
  readonly display_name: string | null
  readonly count: number
  readonly rejected: number
}

interface TurnOriginRow {
  readonly turn_id: string
  readonly origin_json: string
}

const queryError = (
  operation: "resolve" | "page",
  sessionId: string,
  message: string,
  cause?: unknown
): TranscriptQueryError =>
  new TranscriptQueryError({
    operation,
    sessionId,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const corruption = (
  sessionId: string,
  message: string,
  cause?: unknown
): TranscriptDataCorruptionError =>
  new TranscriptDataCorruptionError({
    sessionId,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const conversationCallPredicate = (sql: SqlClient.SqlClient) =>
  sql`
    (
      COALESCE(json_extract(call.value, '$.presentation'), '') = 'conversation'
    )
  `

export const communicationToldSql = (sql: SqlClient.SqlClient) =>
  sql`(json_extract(m.message_json, '$.communication') IS NOT NULL
    AND json_extract(m.message_json, '$.communication.arrival.event') IS NOT 'needs_you')`

const communicationDrawnSql = (sql: SqlClient.SqlClient) =>
  sql`(${communicationToldSql(sql)}
    AND COALESCE(json_extract(m.message_json, '$.communication.shown'), 1) <> 0)`

const ownMessagePredicate = (sql: SqlClient.SqlClient) => sql`
  json_type(m.message_json, '$.forked_from') IS NOT 'text'
  AND NOT EXISTS (
    SELECT 1 FROM session_fork_requests AS fork
    JOIN sessions AS child ON child.session_id = fork.child_session_id
    JOIN session_messages AS boundary ON boundary.session_id = child.session_id
      AND boundary.message_id = json_extract(child.metadata, '$.fork_origin.sourceMessageId')
    WHERE fork.child_session_id = m.session_id
      AND ${sql.literal(disposableForkSql("fork"))}
      AND m.seq <= boundary.seq
  )`

export const conversationMessagePredicate = (sql: SqlClient.SqlClient) =>
  sql`
    ${ownMessagePredicate(sql)} AND
    (
      (
        m.role = 'user'
        AND (
          COALESCE(json_extract(m.message_json, '$.is_meta'), 0) <> 1
          OR json_extract(m.message_json, '$.automation') IS NOT NULL
          -- A message the harness delivered for another sender (an agent, a
          -- Workflow completion) is a row in the conversation, not a hidden
          -- carrier. The harness's own instructions stay out.
          OR COALESCE(json_extract(m.message_json, '$.interaction.from.type'), '')
            IN ('agent', 'workflow')
          OR ${agentResultMessagePredicate(sql)}
          OR ${communicationDrawnSql(sql)}
          OR ${questionAnswerPredicate(sql)}
        )
      )
      OR
      (
        m.role = 'assistant'
        AND m.search_text IS NOT NULL
        AND json_extract(m.message_json, '$.compaction') IS NULL
        AND COALESCE(json_extract(m.message_json, '$.is_meta'), 0) <> 1
      )
      OR
      (
        -- A call whose result is conversation content (a card, a proposal, a
        -- navigation request) keeps its carrier in the conversation stream
        -- even when it says nothing else.
        m.role = 'assistant'
        AND json_extract(m.message_json, '$.compaction') IS NULL
        AND EXISTS (
          SELECT 1
          FROM json_each(m.message_json, '$.tool_calls') AS call
          WHERE ${conversationCallPredicate(sql)}
        )
      )
    )
  `

const toolWorkCarrierMessagePredicate = (sql: SqlClient.SqlClient) =>
  sql`
    ${ownMessagePredicate(sql)} AND
    (
      m.role = 'assistant'
      AND (
        COALESCE(json_array_length(m.message_json, '$.provider_tool_calls'), 0) > 0
        OR EXISTS (
          SELECT 1
          FROM json_each(m.message_json, '$.tool_calls') AS call
          WHERE NOT ${conversationCallPredicate(sql)}
        )
      )
    )
  `

const workCarrierMessagePredicate = (sql: SqlClient.SqlClient) =>
  sql`
    ${ownMessagePredicate(sql)} AND
    (
      m.role = 'assistant'
      AND json_extract(m.message_json, '$.superseded') IS NULL
      AND (
        length(trim(COALESCE(json_extract(m.message_json, '$.reasoning_content'), ''))) > 0
        OR COALESCE(json_array_length(m.message_json, '$.provider_tool_calls'), 0) > 0
        OR EXISTS (
          SELECT 1
          FROM json_each(m.message_json, '$.tool_calls') AS call
          WHERE NOT ${conversationCallPredicate(sql)}
        )
        OR EXISTS (
          SELECT 1
          FROM json_each(m.message_json, '$.output_parts') AS part
          WHERE json_extract(part.value, '$.type') = 'reasoning'
        )
      )
    )
  `

export const makeTranscriptQueries = ({
  reader,
  writer
}: Pick<PersistenceDeps, "reader" | "writer">): TranscriptQueries["Service"] => {
  const sql = reader
  const conversationPredicate = conversationMessagePredicate(sql)
  const workCarrierPredicate = workCarrierMessagePredicate(sql)
  const toolWorkCarrierPredicate = toolWorkCarrierMessagePredicate(sql)

  const decodeRow = Effect.fn("SqliteTranscriptQueries.decodeRow")(function* (row: TranscriptRow) {
    const envelope = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json).pipe(
      Effect.mapError((cause) =>
        corruption(row.session_id, "Transcript message JSON is corrupt", cause)
      )
    )
    const agentResult =
      row.role === "user" && envelope.is_meta === true
        ? yield* agentResultPresentation(sql, row.session_id, row.message_id).pipe(
            Effect.mapError((cause) =>
              corruption(row.session_id, "Could not read agent result", cause)
            )
          )
        : undefined
    const createdAt = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
      row.created_at
    ).pipe(
      Effect.mapError((cause) =>
        corruption(row.session_id, "Transcript message timestamp is corrupt", cause)
      )
    )
    return yield* Schema.decodeUnknownEffect(TranscriptMessageRecordSchema)({
      sessionId: row.session_id,
      messageId: row.message_id,
      sequence: row.seq,
      role: row.role,
      clientId: row.client_id,
      createdAt,
      envelope: agentResult === undefined ? envelope : { ...envelope, agent_result: agentResult }
    }).pipe(
      Effect.mapError((cause) =>
        corruption(row.session_id, "Transcript message row is corrupt", cause)
      )
    )
  })

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

  const pageRaw = Effect.fn("SqliteTranscriptQueries.page")(function* (input: TranscriptPageQuery) {
    const query = yield* Schema.decodeUnknownEffect(TranscriptPageQuerySchema)(input).pipe(
      Effect.mapError((cause) =>
        queryError("page", input.sessionId, "Invalid transcript page query", cause)
      )
    )
    let rows: ReadonlyArray<TranscriptRow>
    switch (query._tag) {
      case "Latest":
        rows = yield* sql<TranscriptRow>`
          SELECT session_id, message_id, seq, role, message_json, client_id, created_at
          FROM session_messages
          WHERE session_id = ${query.sessionId}
          ORDER BY seq DESC
          LIMIT ${query.limit}
        `.pipe(Effect.map((items) => Array.from(items).reverse()))
        break
      case "Before": {
        const items = yield* sql<TranscriptRow>`
          SELECT session_id, message_id, seq, role, message_json, client_id, created_at
          FROM session_messages
          WHERE session_id = ${query.sessionId} AND seq < ${query.sequence}
          ORDER BY seq DESC
          LIMIT ${query.limit}
        `
        rows = Array.from(items).reverse()
        break
      }
      case "After":
        rows = yield* sql<TranscriptRow>`
          SELECT session_id, message_id, seq, role, message_json, client_id, created_at
          FROM session_messages
          WHERE session_id = ${query.sessionId} AND seq > ${query.sequence}
          ORDER BY seq ASC
          LIMIT ${query.limit}
        `
        break
      case "Around": {
        const start = Math.max(0, query.sequence - Math.floor(query.limit / 2))
        rows = yield* sql<TranscriptRow>`
          SELECT session_id, message_id, seq, role, message_json, client_id, created_at
          FROM session_messages
          WHERE session_id = ${query.sessionId} AND seq >= ${start}
          ORDER BY seq ASC
          LIMIT ${query.limit}
        `
        break
      }
    }

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

  const conversationPageRaw = Effect.fn("SqliteTranscriptQueries.conversationPage")(function* (
    input: TranscriptPageQuery
  ) {
    const query = yield* Schema.decodeUnknownEffect(TranscriptPageQuerySchema)(input).pipe(
      Effect.mapError((cause) =>
        queryError("page", input.sessionId, "Invalid conversation page query", cause)
      )
    )
    let rows: ReadonlyArray<TranscriptRow>
    switch (query._tag) {
      case "Latest":
        rows = yield* sql<TranscriptRow>`
            SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                   m.client_id, m.created_at
            FROM session_messages AS m
            WHERE m.session_id = ${query.sessionId} AND ${conversationPredicate}
            ORDER BY m.seq DESC
            LIMIT ${query.limit}
          `.pipe(Effect.map((items) => Array.from(items).reverse()))
        break
      case "Before": {
        const items = yield* sql<TranscriptRow>`
            SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                   m.client_id, m.created_at
            FROM session_messages AS m
            WHERE m.session_id = ${query.sessionId}
              AND m.seq < ${query.sequence}
              AND ${conversationPredicate}
            ORDER BY m.seq DESC
            LIMIT ${query.limit}
          `
        rows = Array.from(items).reverse()
        break
      }
      case "After":
        rows = yield* sql<TranscriptRow>`
            SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                   m.client_id, m.created_at
            FROM session_messages AS m
            WHERE m.session_id = ${query.sessionId}
              AND m.seq > ${query.sequence}
              AND ${conversationPredicate}
            ORDER BY m.seq ASC
            LIMIT ${query.limit}
          `
        break
      case "Around": {
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
        rows = yield* sql<TranscriptRow>`
            SELECT m.session_id, m.message_id, m.seq, m.role, m.message_json,
                   m.client_id, m.created_at
            FROM session_messages AS m
            WHERE m.session_id = ${query.sessionId} AND ${conversationPredicate}
            ORDER BY m.seq ASC
            LIMIT ${query.limit} OFFSET ${offset}
          `
        break
      }
    }

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
      if (query._tag === "Latest") {
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
      if (query._tag === "After") {
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
          AND m.role = 'assistant'
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
    view: "full" | "compact" = "full"
  ) {
    if (turnIds.length === 0 || toolCallIds.length === 0) return []
    const content = sql`json_extract(m.message_json, '$.content')`
    const messageJson =
      view === "compact"
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
          AND ((m.role = 'tool' AND json_extract(m.message_json, '$.async_tool_launch') IS NULL
                AND json_extract(m.message_json, '$.tool_call_id') IN ${sql.in(toolCallIds)})
            OR (m.role = 'user' AND m.client_id IN ${sql.in(toolCallIds.map(asyncResultClientId))}))
        ORDER BY m.seq ASC
      `.pipe(
      Effect.mapError((cause) =>
        queryError("page", sessionId, "Could not hydrate turn-work results", cause)
      )
    )
    return (yield* Effect.forEach(rows, decodeRow)).map(asToolResultRecord)
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

  const toolCallCounts = Effect.fn("SqliteTranscriptQueries.toolCallCounts")(function* (
    sessionId: string,
    turnIds: ReadonlyArray<string>
  ) {
    const counts = new Map<string, Array<TurnToolCallCount>>()
    if (turnIds.length === 0) return counts
    // CROSS JOIN keeps session_turns outermost, so each turn reads only its
    // own (session_id, seq) range. With a plain JOIN SQLite drove the query
    // from the transcript and parsed every message of the chat twice: 160 ms
    // instead of 5 ms on a 22k-message chat.
    const rows = yield* sql<ToolCallCountRow>`
        SELECT turn_id, name, display_name, COUNT(*) AS count, SUM(rejected) AS rejected
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
            AND NOT ${conversationCallPredicate(sql)}
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
      Effect.mapError((cause) =>
        queryError("page", sessionId, "Could not count turn tool calls", cause)
      )
    )
    for (const row of rows) {
      const list = counts.get(row.turn_id) ?? []
      list.push({
        name: row.name,
        display_name: row.display_name,
        count: row.count,
        rejected: row.rejected
      })
      counts.set(row.turn_id, list)
    }
    return counts
  })

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
    toolCallCounts,
    originsForTurns,
    ...makeTranscriptSearches(sql, writer.sql, conversationMessagePredicate)
  })
}
