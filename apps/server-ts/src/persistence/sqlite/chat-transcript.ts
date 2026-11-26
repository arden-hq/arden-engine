import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Predicate, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { ChatCheckpointAnchor, ChatWriteError } from "../chat/store.js"
import {
  messageAuthor,
  MessageRoleSchema,
  StoredMessageEnvelopeSchema,
  visibleMessageCount,
  withoutTurnStamp,
  type StoredMessageEnvelope
} from "../transcript/model.js"
import { transcriptSearchText } from "../transcript/search-text.js"
import { decodeJson, encodeJson } from "./json.js"
import { appendSessionTurn } from "./turns.js"
import { writeError, type ChatWriteOperation } from "./chat-write-errors.js"
import {
  ActiveContextError,
  loadActiveContext,
  loadActiveIds,
  loadLastActiveMessage,
  loadActiveTail
} from "./active-context.js"
import { turnTouchesRecencySql } from "./session-unread.js"
import { releaseKeyMessageCopies } from "./chat-key-message.js"

export const MessageListSchema = Schema.Array(StoredMessageEnvelopeSchema)
const envelopeEquivalent = Schema.toEquivalence(StoredMessageEnvelopeSchema)
const messageEquivalent = (left: StoredMessageEnvelope, right: StoredMessageEnvelope): boolean =>
  envelopeEquivalent(withoutTurnStamp(left), withoutTurnStamp(right))

interface TranscriptEnvelopeRow {
  readonly seq: number
  readonly message_id: string
  readonly role: string
  readonly message_json: string
  readonly client_id: string | null
  readonly created_at: string
}

export const loadActiveMessages = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  operation: ChatWriteOperation
): Effect.Effect<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> =>
  loadActiveContext(sql, sessionId).pipe(Effect.mapError(contextError(operation, sessionId)))

export const loadLastActiveMessageFor = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  operation: ChatWriteOperation
): Effect.Effect<StoredMessageEnvelope | undefined, ChatWriteError> =>
  loadLastActiveMessage(sql, sessionId).pipe(Effect.mapError(contextError(operation, sessionId)))

export const contextError =
  (
    operation: ChatWriteOperation,
    sessionId: string
  ): ((cause: ActiveContextError | SqlError.SqlError) => ChatWriteError) =>
  (cause: ActiveContextError | SqlError.SqlError): ChatWriteError =>
    cause instanceof ActiveContextError
      ? writeError(operation, cause.reason, cause.message, { sessionId, cause })
      : writeError(operation, "storage", "Could not load the active context", {
          sessionId,
          cause
        })

export const historyTail = Effect.fn("SqliteChatWriteStore.historyTail")(function* (
  sql: SqlClient.SqlClient,
  ids: { readonly sessionId: string; readonly runId: string },
  messages: ReadonlyArray<StoredMessageEnvelope>,
  operation: ChatWriteOperation
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
  const activeIds = yield* loadActiveIds(sql, ids.sessionId).pipe(
    Effect.mapError(contextError(operation, ids.sessionId))
  )
  const rewritten = () =>
    writeError(operation, "invalid", "Chat history cannot remove or rewrite active messages", ids)
  if (
    messages.length < activeIds.length ||
    activeIds.some((id, index) => messages[index]?.message_id !== id)
  ) {
    return yield* rewritten()
  }
  const newest = messages[activeIds.length - 1]
  if (newest !== undefined) {
    const stored = yield* loadLastActiveMessageFor(sql, ids.sessionId, operation)
    if (stored === undefined || !messageEquivalent(stored, newest)) return yield* rewritten()
  }
  return messages.slice(activeIds.length)
})

export const appendedHistoryTail = Effect.fn("SqliteChatWriteStore.appendedHistoryTail")(function* (
  sql: SqlClient.SqlClient,
  ids: { readonly sessionId: string; readonly runId: string },
  anchor: ChatCheckpointAnchor,
  messages: ReadonlyArray<StoredMessageEnvelope>
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
  const rewritten = () =>
    writeError(
      "checkpoint",
      "invalid",
      "Chat history cannot remove or rewrite active messages",
      ids
    )
  const rows = yield* sql<{
    readonly context_generation: number
    readonly active_message_count: number
  }>`
      SELECT context_generation, active_message_count FROM sessions
      WHERE session_id = ${ids.sessionId}
    `.pipe(Effect.mapError(contextError("checkpoint", ids.sessionId)))
  const state = rows[0]
  if (
    state === undefined ||
    state.context_generation !== anchor.contextGeneration ||
    state.active_message_count < anchor.activeCount
  )
    return yield* rewritten()
  const alreadyStored = state.active_message_count - anchor.activeCount
  if (alreadyStored > messages.length) return yield* rewritten()
  const tail = yield* loadActiveTail(
    sql,
    ids.sessionId,
    alreadyStored + (anchor.activeCount > 0 ? 1 : 0)
  ).pipe(Effect.mapError(contextError("checkpoint", ids.sessionId)))
  const boundary = anchor.activeCount > 0 ? tail[0] : undefined
  if (
    (anchor.activeCount > 0 &&
      (anchor.lastMessage === null ||
        boundary === undefined ||
        !messageEquivalent(boundary, anchor.lastMessage))) ||
    (anchor.activeCount === 0 && anchor.lastMessage !== null)
  )
    return yield* rewritten()
  const stored = anchor.activeCount > 0 ? tail.slice(1) : tail
  if (
    stored.length !== alreadyStored ||
    stored.some((message, index) => {
      const next = messages[index]
      return next === undefined || !messageEquivalent(message, next)
    })
  )
    return yield* rewritten()
  return messages.slice(alreadyStored)
})

const rejectExistingMessageId = Effect.fn("SqliteChatWriteStore.rejectExistingMessageId")(
  function* (
    sql: SqlClient.SqlClient,
    sessionId: string,
    message: StoredMessageEnvelope,
    operation: ChatWriteOperation
  ): Effect.fn.Return<void, ChatWriteError> {
    const rows = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present
    FROM session_messages
    WHERE session_id = ${sessionId} AND message_id = ${message.message_id}
    LIMIT 1
  `.pipe(
      Effect.mapError((cause) =>
        writeError(operation, "storage", "Could not inspect transcript message id", {
          sessionId,
          cause
        })
      )
    )
    if (rows.length > 0) {
      return yield* writeError(
        operation,
        "corrupt",
        "Message id already exists in the transcript",
        { sessionId }
      )
    }
  }
)

export const loadTranscriptEnvelopesById = Effect.fn(
  "SqliteChatWriteStore.loadTranscriptEnvelopesById"
)(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  messageIds: ReadonlyArray<string>,
  operation: ChatWriteOperation
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
  if (messageIds.length === 0) return []
  const rows = yield* sql<TranscriptEnvelopeRow>`
    SELECT seq, message_id, role, message_json, client_id, created_at
    FROM session_messages
    WHERE session_id = ${sessionId}
      AND message_id IN ${sql.in(messageIds)}
    ORDER BY seq
  `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not load the active durable Chat transcript", {
        sessionId,
        cause
      })
    )
  )
  return yield* decodeTranscriptRows(rows, sessionId, operation)
})

export const rejectTranscriptIds = Effect.fn("SqliteChatWriteStore.rejectTranscriptIds")(function* (
  sql: SqlClient.SqlClient,
  run: { readonly session_id: string; readonly run_id: string },
  appended: ReadonlyArray<StoredMessageEnvelope>,
  operation: ChatWriteOperation
): Effect.fn.Return<void, ChatWriteError> {
  if (appended.length === 0) return
  const known = yield* sql<{ readonly present: number }>`
      SELECT 1 AS present FROM session_messages
      WHERE session_id = ${run.session_id}
        AND message_id IN ${sql.in(appended.map((message) => message.message_id))}
      LIMIT 1
    `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not inspect transcript message ids", {
        sessionId: run.session_id,
        runId: run.run_id,
        cause
      })
    )
  )
  if (known.length > 0) {
    return yield* writeError(
      operation,
      "invalid",
      "Chat history cannot reorder transcript messages",
      { sessionId: run.session_id, runId: run.run_id }
    )
  }
})

export const loadMintedMessageIds = Effect.fn("SqliteChatWriteStore.loadMintedMessageIds")(
  function* (
    sql: SqlClient.SqlClient,
    sessionId: string,
    assistantMessageId: string,
    operation: ChatWriteOperation
  ): Effect.fn.Return<ReadonlyArray<string>, ChatWriteError> {
    const mintedPrefix = `${assistantMessageId}-`
    const rows = yield* sql<{ readonly message_id: string }>`
      SELECT message_id
      FROM session_messages
      WHERE session_id = ${sessionId}
        AND role = ${ROLE.assistant}
        AND (message_id = ${assistantMessageId}
          OR substr(message_id, 1, ${mintedPrefix.length}) = ${mintedPrefix})
      ORDER BY seq
    `.pipe(
      Effect.mapError((cause) =>
        writeError(operation, "storage", "Could not load the run's minted message ids", {
          sessionId,
          cause
        })
      )
    )
    return rows.map((row) => row.message_id)
  }
)

const decodeTranscriptRows = Effect.fn("SqliteChatWriteStore.decodeTranscriptRows")(function* (
  rows: ReadonlyArray<TranscriptEnvelopeRow>,
  sessionId: string,
  operation: ChatWriteOperation
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
  const messages: Array<StoredMessageEnvelope> = []
  let previousSequence = -1
  for (const row of rows) {
    if (!Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq <= previousSequence) {
      return yield* writeError(
        operation,
        "corrupt",
        "The durable Chat transcript sequence is invalid",
        {
          sessionId
        }
      )
    }
    previousSequence = row.seq
    const message = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json).pipe(
      Effect.mapError((cause) =>
        writeError(operation, "corrupt", "The durable Chat transcript is corrupt", {
          sessionId,
          cause
        })
      )
    )
    const role = yield* Schema.decodeUnknownEffect(MessageRoleSchema)(row.role).pipe(
      Effect.mapError((cause) =>
        writeError(operation, "corrupt", "The durable Chat transcript role is invalid", {
          sessionId,
          cause
        })
      )
    )
    if (
      message.message_id !== row.message_id ||
      message.role !== role ||
      (message.client_id ?? null) !== row.client_id ||
      message.created_at !== row.created_at
    ) {
      return yield* writeError(
        operation,
        "corrupt",
        "The durable Chat transcript identity is invalid",
        {
          sessionId
        }
      )
    }
    messages.push(message)
  }
  return messages
})

export const appendMessagesInTransaction = Effect.fn("SqliteChatWriteStore.appendMessages")(
  function* (
    sql: SqlClient.SqlClient,
    sessionId: string,
    batch: ReadonlyArray<StoredMessageEnvelope>,
    timestamp: string,
    operation: ChatWriteOperation,
    turnId: string
  ): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
    const first = batch[0]
    if (first === undefined) return []
    const nextMessageSequence = yield* sql<{ readonly value: number }>`
    SELECT COALESCE(MAX(seq) + 1, 0) AS value
    FROM session_messages
    WHERE session_id = ${sessionId}
  `.pipe(
      Effect.mapError((cause) =>
        writeError(operation, "storage", "Could not allocate message sequence", {
          sessionId,
          cause
        })
      )
    )
    const firstSequence = nextMessageSequence[0]?.value ?? 0
    let sequence = firstSequence
    const stamped: Array<StoredMessageEnvelope> = []
    for (const message of batch) {
      yield* rejectExistingMessageId(sql, sessionId, message, operation)
      const stampedMessage = { ...message, turn_id: turnId }
      const messageJson = yield* encodeJson(StoredMessageEnvelopeSchema, stampedMessage).pipe(
        Effect.mapError((cause) =>
          writeError(operation, "invalid", "Chat message cannot be encoded", {
            sessionId,
            cause
          })
        )
      )
      yield* sql`
      INSERT INTO session_messages (
        session_id, message_id, seq, role, message_json, client_id,
        created_at, search_text, author
      ) VALUES (
        ${sessionId}, ${message.message_id}, ${sequence}, ${message.role},
        ${messageJson}, ${message.client_id ?? null}, ${message.created_at},
        ${transcriptSearchText(message)}, ${messageAuthor(message)}
      )
    `.pipe(
        Effect.mapError((cause) =>
          writeError(operation, "storage", "Could not persist message", {
            sessionId,
            cause
          })
        )
      )
      stamped.push(stampedMessage)
      sequence += 1
    }
    yield* sql`
    UPDATE sessions
    SET active_message_count = active_message_count + ${stamped.length},
        visible_message_count = visible_message_count + ${visibleMessageCount(stamped)},
        last_activity = CASE WHEN archived_at IS NULL
          AND ${turnTouchesRecencySql(sql, { sessionId, turnId })} THEN ${timestamp} ELSE last_activity END
    WHERE session_id = ${sessionId}
  `.pipe(
      Effect.mapError((cause) =>
        writeError(operation, "storage", "Could not update session messages", {
          sessionId,
          cause
        })
      )
    )
    yield* appendSessionTurn(sql, {
      sessionId,
      turnId,
      firstSequence,
      messages: batch
    }).pipe(
      Effect.mapError((cause) =>
        writeError(operation, "storage", "Could not update session turn", {
          sessionId,
          cause
        })
      )
    )
    yield* releaseKeyMessageCopies(sql, sessionId, batch).pipe(
      Effect.mapError((cause) =>
        writeError(operation, "storage", "Could not settle admitted message copies", {
          sessionId,
          cause
        })
      )
    )
    return stamped
  }
)

export const hasToolIntent = (message: StoredMessageEnvelope | undefined): boolean =>
  message?.role === ROLE.assistant &&
  Array.isArray(message.tool_calls) &&
  message.tool_calls.length > 0

export const hasResumableTail = (
  messages: ReadonlyArray<StoredMessageEnvelope>,
  certifiedToolTail = false
): boolean => {
  const last = messages[messages.length - 1]
  if (last === undefined) return false
  if (
    last.role === ROLE.tool
      ? !certifiedToolTail
      : last.role !== ROLE.assistant || hasToolIntent(last)
  )
    return true
  const toolOutputs = new Set(
    messages.flatMap((message) =>
      message.role === ROLE.tool &&
      message.async_tool_launch === undefined &&
      message.tool_call_id !== undefined
        ? [message.tool_call_id]
        : []
    )
  )
  const launched = new Set(
    messages.flatMap((message) => {
      const launch = message.async_tool_launch
      return Predicate.isObject(launch) && typeof launch.call_id === "string"
        ? [launch.call_id]
        : []
    })
  )
  const unfinishedCall = messages.some(
    (message) =>
      message.role === ROLE.assistant &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some(
        (call) =>
          Predicate.isObject(call) &&
          typeof call.id === "string" &&
          !toolOutputs.has(call.id) &&
          !launched.has(call.id)
      )
  )
  if (unfinishedCall) return true
  return [...launched].some((callId) => !toolOutputs.has(callId))
}
