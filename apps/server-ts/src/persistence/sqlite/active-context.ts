import { Effect, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import {
  MessageRoleSchema,
  StoredMessageEnvelopeSchema,
  visibleMessageCount,
  type StoredMessageEnvelope
} from "../transcript/model.js"
import { decodeJson } from "./json.js"

export class ActiveContextError extends Schema.TaggedError<ActiveContextError>()(
  "ActiveContextError",
  {
    reason: Schema.Literals(["corrupt", "invalid"] as const),
    message: Schema.String,
    sessionId: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

type ActiveContextFailure = ActiveContextError | SqlError.SqlError

const MessageListSchema = Schema.Array(StoredMessageEnvelopeSchema)

interface BoundsRow {
  readonly context_from_seq: number | null
  readonly context_head_seq: number | null
  readonly active_message_count: number
  readonly messages: string | null
}

type Bounds =
  | {
      readonly kind: "window"
      readonly from: number
      readonly head: number | null
      readonly count: number
    }
  | { readonly kind: "array"; readonly messages: string | null; readonly count: number }

interface ActiveRow {
  readonly seq: number
  readonly message_id: string
  readonly role: string
  readonly message_json: string
  readonly client_id: string | null
  readonly created_at: string
}

const loadBounds = Effect.fn("ActiveContext.loadBounds")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<Bounds, ActiveContextFailure> {
  const rows = yield* sql<BoundsRow>`
    SELECT context_from_seq, context_head_seq, active_message_count,
      CASE WHEN context_from_seq IS NULL THEN messages END AS messages
    FROM sessions WHERE session_id = ${sessionId}
  `
  const row = rows[0]
  if (row === undefined) {
    return yield* new ActiveContextError({
      reason: "invalid",
      message: "This chat no longer exists.",
      sessionId
    })
  }
  return row.context_from_seq === null
    ? { kind: "array", messages: row.messages, count: row.active_message_count }
    : {
        kind: "window",
        from: row.context_from_seq,
        head: row.context_head_seq,
        count: row.active_message_count
      }
})

const windowRows = <Row extends object>(
  sql: SqlClient.SqlClient,
  sessionId: string,
  bounds: { readonly from: number; readonly head: number | null },
  columns: "ids" | "envelopes"
) => sql<Row>`
  SELECT m.seq, m.message_id
    ${columns === "envelopes" ? sql`, m.role, m.message_json, m.client_id, m.created_at` : sql``}
  FROM session_messages AS m
  WHERE m.session_id = ${sessionId}
    AND (m.seq >= ${bounds.from} OR m.seq = ${bounds.head})
    AND ${visible(sql)}
  ORDER BY m.seq IS ${bounds.head} DESC, m.seq ASC
`

const visible = (sql: SqlClient.SqlClient) => sql`NOT EXISTS (
  SELECT 1 FROM session_context_hidden AS hidden
  WHERE hidden.session_id = m.session_id AND hidden.seq = m.seq
)`

const newestRow = Effect.fn("ActiveContext.newestRow")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  bounds: { readonly from: number; readonly head: number | null }
): Effect.fn.Return<ActiveRow | undefined, SqlError.SqlError> {
  const rows = yield* sql<ActiveRow>`
    SELECT m.seq, m.message_id, m.role, m.message_json, m.client_id, m.created_at
    FROM session_messages AS m
    WHERE m.session_id = ${sessionId} AND m.seq >= ${bounds.from}
      AND m.seq IS NOT ${bounds.head} AND ${visible(sql)}
    ORDER BY m.seq DESC LIMIT 1
  `
  if (rows[0] !== undefined || bounds.head === null) return rows[0]
  const head = yield* sql<ActiveRow>`
    SELECT m.seq, m.message_id, m.role, m.message_json, m.client_id, m.created_at
    FROM session_messages AS m
    WHERE m.session_id = ${sessionId} AND m.seq = ${bounds.head}
  `
  return head[0]
})

const requireCount = (
  sessionId: string,
  expected: number,
  found: number
): Effect.Effect<void, ActiveContextError> =>
  found === expected
    ? Effect.void
    : Effect.fail(
        new ActiveContextError({
          reason: "corrupt",
          message: "The active context does not match active_message_count",
          sessionId
        })
      )

const decodeArray = Effect.fn("ActiveContext.decodeArray")(function* (
  sessionId: string,
  bounds: Extract<Bounds, { kind: "array" }>
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ActiveContextError> {
  const messages =
    bounds.messages === null
      ? []
      : yield* decodeJson(MessageListSchema, bounds.messages).pipe(
          Effect.mapError(
            (cause) =>
              new ActiveContextError({
                reason: "corrupt",
                message: "Session projection is corrupt",
                sessionId,
                cause
              })
          )
        )
  yield* requireCount(sessionId, bounds.count, messages.length)
  return messages
})

export const loadActiveContext = Effect.fn("ActiveContext.load")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ActiveContextFailure> {
  const bounds = yield* loadBounds(sql, sessionId)
  if (bounds.kind === "array") return yield* decodeArray(sessionId, bounds)
  const rows = yield* windowRows<ActiveRow>(sql, sessionId, bounds, "envelopes")
  yield* requireCount(sessionId, bounds.count, rows.length)
  return yield* Effect.forEach(rows, (row) => decodeRow(sessionId, row))
})

export const loadActiveIds = Effect.fn("ActiveContext.loadIds")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<ReadonlyArray<string>, ActiveContextFailure> {
  const bounds = yield* loadBounds(sql, sessionId)
  if (bounds.kind === "array") {
    return (yield* decodeArray(sessionId, bounds)).map((message) => message.message_id)
  }
  const rows = yield* windowRows<Pick<ActiveRow, "message_id">>(sql, sessionId, bounds, "ids")
  yield* requireCount(sessionId, bounds.count, rows.length)
  return rows.map((row) => row.message_id)
})

export const loadLastActiveMessage = Effect.fn("ActiveContext.loadLast")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<StoredMessageEnvelope | undefined, ActiveContextFailure> {
  const bounds = yield* loadBounds(sql, sessionId)
  if (bounds.kind === "array") return (yield* decodeArray(sessionId, bounds)).at(-1)
  const row = yield* newestRow(sql, sessionId, bounds)
  if (row === undefined) {
    yield* requireCount(sessionId, bounds.count, 0)
    return undefined
  }
  return yield* decodeRow(sessionId, row)
})

export const loadActiveTail = Effect.fn("ActiveContext.loadTail")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  limit: number
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ActiveContextFailure> {
  if (limit <= 0) return []
  const bounds = yield* loadBounds(sql, sessionId)
  if (bounds.kind === "array") return (yield* decodeArray(sessionId, bounds)).slice(-limit)
  const rows = yield* sql<ActiveRow>`
    SELECT m.seq, m.message_id, m.role, m.message_json, m.client_id, m.created_at
    FROM session_messages AS m
    WHERE m.session_id = ${sessionId}
      AND (m.seq >= ${bounds.from} OR m.seq = ${bounds.head})
      AND ${visible(sql)}
    ORDER BY m.seq IS ${bounds.head} ASC, m.seq DESC
    LIMIT ${limit}
  `
  if (rows.length !== Math.min(bounds.count, limit)) {
    return yield* new ActiveContextError({
      reason: "corrupt",
      message: "The active context does not match active_message_count",
      sessionId
    })
  }
  return yield* Effect.forEach([...rows].reverse(), (row) => decodeRow(sessionId, row))
})

export const hideFromActiveContext = Effect.fn("ActiveContext.hide")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  seq: number
): Effect.fn.Return<void, ActiveContextFailure> {
  yield* requireActiveContextWindow(sql, sessionId)
  yield* sql`INSERT OR IGNORE INTO session_context_hidden (session_id, seq)
    VALUES (${sessionId}, ${seq})`
})

const ID_CHUNK = 500

export const replaceActiveContext = Effect.fn("ActiveContext.replace")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  messages: ReadonlyArray<StoredMessageEnvelope>
): Effect.fn.Return<void, ActiveContextFailure> {
  const ids = messages.map((message) => message.message_id)
  const seqById = new Map<string, number>()
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const rows = yield* sql<Pick<ActiveRow, "seq" | "message_id">>`
      SELECT seq, message_id FROM session_messages
      WHERE session_id = ${sessionId} AND message_id IN ${sql.in(ids.slice(start, start + ID_CHUNK))}
    `
    for (const row of rows) seqById.set(row.message_id, row.seq)
  }
  const seqs = ids.flatMap((id) => {
    const seq = seqById.get(id)
    return seq === undefined ? [] : [seq]
  })
  if (seqs.length !== ids.length) {
    return yield* new ActiveContextError({
      reason: "invalid",
      message:
        "This chat’s saved context no longer matches its messages. Reopen the chat, or start a new one if this keeps happening.",
      sessionId
    })
  }
  const head = ascending(seqs) ? null : (seqs[0] ?? null)
  if (head !== null && !ascending(seqs.slice(1))) {
    return yield* new ActiveContextError({
      reason: "invalid",
      message:
        "This chat’s saved context no longer matches its messages. Reopen the chat, or start a new one if this keeps happening.",
      sessionId
    })
  }
  yield* writeWindow(sql, sessionId, {
    seqs,
    head,
    count: messages.length,
    visible: visibleMessageCount(messages)
  })
})

const writeWindow = Effect.fn("ActiveContext.writeWindow")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  window: {
    readonly seqs: ReadonlyArray<number>
    readonly head: number | null
    readonly count: number
    readonly visible: number | null
  }
): Effect.fn.Return<void, SqlError.SqlError> {
  const listed = window.head === null ? window.seqs : window.seqs.slice(1)
  const newest = yield* sql<{ readonly seq: number | null }>`
    SELECT MAX(seq) AS seq FROM session_messages WHERE session_id = ${sessionId}
  `
  const from = listed[0] ?? (window.head === null ? (newest[0]?.seq ?? -1) + 1 : window.head + 1)
  yield* sql`
    UPDATE sessions
    SET context_from_seq = ${from}, context_head_seq = ${window.head}, messages = NULL,
        active_message_count = ${window.count},
        visible_message_count = COALESCE(${window.visible}, visible_message_count)
    WHERE session_id = ${sessionId}
  `
  yield* sql`DELETE FROM session_context_hidden WHERE session_id = ${sessionId}`
  yield* sql`
    INSERT INTO session_context_hidden (session_id, seq)
    SELECT ${sessionId}, m.seq FROM session_messages AS m
    WHERE m.session_id = ${sessionId} AND m.seq >= ${from}
      AND m.seq NOT IN (SELECT value FROM json_each(${JSON.stringify(window.seqs)}))
  `
})

export const requireActiveContextWindow = Effect.fn("ActiveContext.requireWindow")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<void, ActiveContextFailure> {
  const rows = yield* sql<{
    readonly context_from_seq: number | null
    readonly valid: number | null
  }>`
    SELECT context_from_seq, json_valid(messages) AS valid
    FROM sessions WHERE session_id = ${sessionId}
  `
  const row = rows[0]
  if (row === undefined || row.context_from_seq !== null) return
  if (row.valid === 0) {
    return yield* new ActiveContextError({
      reason: "corrupt",
      message: "Session projection is corrupt",
      sessionId
    })
  }
  return yield* new ActiveContextError({
    reason: "invalid",
    message: "Legacy context was not prepared before the write transaction",
    sessionId
  })
})

const ascending = (values: ReadonlyArray<number>): boolean =>
  values.every((value, index) => index === 0 || value > (values[index - 1] ?? value))

const decodeRow = Effect.fn("ActiveContext.decodeRow")(function* (
  sessionId: string,
  row: ActiveRow
): Effect.fn.Return<StoredMessageEnvelope, ActiveContextError> {
  const corrupt = (message: string) => (cause?: unknown) =>
    new ActiveContextError({
      reason: "corrupt",
      message,
      sessionId,
      ...(cause === undefined ? {} : { cause })
    })
  const message = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json).pipe(
    Effect.mapError(corrupt("The durable Chat transcript is corrupt"))
  )
  const role = yield* Schema.decodeUnknownEffect(MessageRoleSchema)(row.role).pipe(
    Effect.mapError(corrupt("The durable Chat transcript role is invalid"))
  )
  if (
    message.message_id !== row.message_id ||
    message.role !== role ||
    (message.client_id ?? null) !== row.client_id ||
    message.created_at !== row.created_at
  ) {
    return yield* corrupt("The durable Chat transcript identity is invalid")()
  }
  return message
})
