import { AUTOMATION_CONTEXT_MODE } from "@arden-hq/protocol/automations"
import { SESSION_TYPE } from "@arden-hq/protocol/sessions"
import { machineTimeZone } from "@arden-hq/std/time"
import { DateTime, Duration, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { chatEventLines, chatEventsMessage, type ChatEvent } from "../transcript/chat-events.js"
import type { StoredMessageEnvelope } from "../transcript/model.js"
import type { ChatWriteError } from "../chat/store.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { appendMessagesInTransaction } from "./chat-transcript.js"
import { writeError, type ChatWriteOperation } from "./chat-write-errors.js"
import { currentSessionTurnId } from "./turns.js"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  type InScope,
  type ChatScope,
  arrivals,
  answers,
  proposals,
  focusChoices,
  failedTurns
} from "./chat-event-sources.js"
import { approvals, waiting } from "./chat-event-approvals.js"

const FIRST_LOOK = Duration.days(3)
const LATE_SLACK = Duration.days(2)

export interface ChatEventsLook {
  readonly since: string
  readonly batch: ChatEventsBatch | undefined
}

interface ChatEventsBatch {
  readonly message: StoredMessageEnvelope
  readonly keys: ReadonlyArray<string>
}

export const findChatEvents = Effect.fn("SqliteChatEvents.find")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly now: DateTime.Utc
    readonly timeZone?: string
  }
): Effect.fn.Return<ChatEventsLook | undefined, SqlError> {
  const { sessionId } = options
  const scope = (yield* sql<ChatScope>`SELECT s.session_type, s.space_id,
      conversation.session_id AS space_conversation_id, cursor.checked_at
    FROM sessions AS s
    LEFT JOIN space_conversations AS conversation ON conversation.space_id = s.space_id
    LEFT JOIN chat_event_cursors AS cursor ON cursor.session_id = s.session_id
    WHERE s.session_id = ${sessionId} AND s.archived_at IS NULL`)[0]
  if (scope === undefined || scope.session_type === SESSION_TYPE.agent) return undefined
  const since = DateTime.formatIso(
    scope.checked_at === null
      ? DateTime.subtractDuration(options.now, FIRST_LOOK)
      : DateTime.subtractDuration(DateTime.makeUnsafe(scope.checked_at), LATE_SLACK)
  )
  const spaceHome = scope.space_conversation_id === sessionId ? scope.space_id : null
  const started = new Set(
    spaceHome !== null || scope.space_id === null
      ? []
      : (yield* sql<{ readonly item_id: string }>`SELECT item_id FROM space_tasks
          WHERE home_session_id = ${sessionId}`).map((row) => row.item_id)
  )
  const inScope: InScope = (item) =>
    (spaceHome !== null && item.spaceId === spaceHome) ||
    (item.itemId !== null && started.has(item.itemId))

  const byKey = new Map<string, ChatEvent>()
  for (const event of [
    ...(yield* arrivals(sql, { sessionId, since, scope, spaceHome, inScope })),
    ...(yield* waiting(sql, { sessionId, since, inScope })),
    ...(yield* answers(sql, { sessionId, since, inScope })),
    ...(yield* approvals(sql, { sessionId, since, inScope })),
    ...(yield* proposals(sql, { sessionId, since, spaceHome })),
    ...(yield* focusChoices(sql, { sessionId, since })),
    ...(yield* failedTurns(sql, { sessionId, since }))
  ]) {
    if (!byKey.has(event.key)) byKey.set(event.key, event)
  }
  const found: ReadonlyArray<ChatEvent> = [...byKey.values()]
  const delivered = new Set(
    found.length === 0
      ? []
      : (yield* sql<{
          readonly event_key: string
        }>`SELECT event_key FROM chat_event_deliveries AS delivered
          WHERE event_key IN ${sql.in(found.map((event) => event.key))}
            AND (delivered.session_id = ${sessionId} OR EXISTS (
              SELECT 1 FROM session_messages AS inherited
              WHERE inherited.session_id = ${sessionId}
                AND inherited.message_id = delivered.message_id
            ))`).map((row) => row.event_key)
  )
  const fresh = found.filter((event) => !delivered.has(event.key))
  if (fresh.length === 0) return { since, batch: undefined }
  const keys = fresh.map((event) => event.key)
  const digest = sha256Hex(keys.join("\n"))
  const messageId = `chat-events:${digest.slice(0, 32)}`
  const existing = yield* sql`SELECT 1 FROM session_messages
    WHERE session_id = ${sessionId} AND message_id = ${messageId} LIMIT 1`
  if (existing.length > 0) return { since, batch: undefined }
  const lines = chatEventLines(fresh, {
    now: new Date(DateTime.toEpochMillis(options.now)),
    timeZone: options.timeZone ?? machineTimeZone(),
    listTool: scope.space_id === null ? "session_read" : "space_board_read"
  })
  return {
    since,
    batch: {
      message: chatEventsMessage({
        messageId,
        createdAt: DateTime.formatIso(options.now),
        lines
      }),
      keys
    }
  }
})

export const appendChatEventsBeforeTurn = Effect.fn("SqliteChatEvents.beforeTurn")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly now: DateTime.Utc
  }
): Effect.fn.Return<void, ChatWriteError> {
  const look = yield* findChatEvents(sql, {
    sessionId: options.sessionId,
    now: options.now
  }).pipe(Effect.mapError(lookError("start", options.sessionId)))
  if (look === undefined) return
  yield* appendChatEventsInTransaction(sql, {
    ...options,
    look,
    operation: "start",
    turnId: undefined
  })
})

export const takeChatEventsBeforeQueued = Effect.fn("SqliteChatEvents.beforeQueued")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly run: { readonly session_id: string; readonly automation_context_mode: string | null }
    readonly queued: number
    readonly now: DateTime.Utc
    readonly operation: ChatWriteOperation
  }
): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
  if (options.queued === 0 || options.run.automation_context_mode === AUTOMATION_CONTEXT_MODE.fresh)
    return []
  const sessionId = options.run.session_id
  const look = yield* findChatEvents(sql, { sessionId, now: options.now }).pipe(
    Effect.mapError(lookError(options.operation, sessionId))
  )
  if (look === undefined) return []
  yield* recordChatEvents(sql, { ...options, sessionId, look })
  return look.batch === undefined ? [] : [look.batch.message]
})

const recordChatEvents = Effect.fn("SqliteChatEvents.record")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly look: ChatEventsLook
    readonly now: DateTime.Utc
    readonly operation: ChatWriteOperation
  }
): Effect.fn.Return<void, ChatWriteError> {
  const { sessionId } = options
  const nowIso = DateTime.formatIso(options.now)
  const batch = options.look.batch
  yield* Effect.gen(function* () {
    yield* sql`INSERT INTO chat_event_cursors (session_id, checked_at) VALUES (${sessionId}, ${nowIso})
      ON CONFLICT(session_id) DO UPDATE SET checked_at = MAX(checked_at, excluded.checked_at)`
    yield* sql`DELETE FROM chat_event_deliveries
      WHERE session_id = ${sessionId} AND delivered_at < ${options.look.since}`
    if (batch === undefined) return
    for (const key of batch.keys) {
      yield* sql`INSERT INTO chat_event_deliveries (session_id, event_key, message_id, delivered_at)
        VALUES (${sessionId}, ${key}, ${batch.message.message_id}, ${nowIso})`
    }
  }).pipe(
    Effect.mapError((cause) =>
      writeError(options.operation, "storage", "Could not record chat events", {
        sessionId,
        cause
      })
    )
  )
})

export const lookError =
  (operation: ChatWriteOperation, sessionId: string): ((cause: unknown) => ChatWriteError) =>
  (cause: unknown): ChatWriteError =>
    writeError(operation, "storage", "Could not read chat events", { sessionId, cause })

export const appendChatEventsInTransaction = Effect.fn("SqliteChatEvents.append")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionId: string
    readonly look: ChatEventsLook
    readonly now: DateTime.Utc
    readonly operation: ChatWriteOperation
    readonly turnId: string | undefined
  }
): Effect.fn.Return<void, ChatWriteError> {
  const { sessionId } = options
  const batch = options.look.batch
  yield* recordChatEvents(sql, options)
  if (batch === undefined) return
  const turnId =
    options.turnId ??
    (yield* currentSessionTurnId(sql, sessionId).pipe(
      Effect.mapError((cause) =>
        writeError(options.operation, "storage", "Could not read the chat's newest turn", {
          sessionId,
          cause
        })
      )
    )) ??
    batch.message.message_id
  yield* appendMessagesInTransaction(
    sql,
    sessionId,
    [batch.message],
    DateTime.formatIso(options.now),
    options.operation,
    turnId
  )
})
