import { CHAT_QUEUE_LIMIT } from "@arden-hq/protocol/chat"
import { DateTime, Effect, Schema, type Scope } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  ChatWriteConflictError,
  type ChatQueueHead,
  type ChatQueuedMessage,
  type ChatQueueEnqueueInput,
  type ChatWriteError,
  type ChatWriteFailure,
  type ChatWriteStore
} from "../chat/store.js"
import { decodeJson, encodeJson } from "./json.js"
import { loadSession } from "./chat-session.js"
import { dropPendingArchive } from "./pending-archive.js"
import { mapFailure, validateInput, writeError } from "./chat-write-errors.js"
import type { PersistenceDeps } from "./deps.js"
import { foregroundRunStatusList } from "./status-sets.js"

const QueuedImagesSchema = Schema.Array(
  Schema.Struct({
    mediaType: Schema.Literals(["image/png", "image/jpeg"] as const),
    data: Schema.NonEmptyString
  })
)

const queuedMessageAddressSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString
})

const enqueueInputSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  message: Schema.String,
  images: QueuedImagesSchema,
  sentFrom: Schema.optionalKey(Schema.Literals(["answer", "visualization"] as const))
}).check(
  Schema.makeFilter((input) =>
    input.message.trim().length > 0 || input.images.length > 0
      ? undefined
      : { path: ["message"], issue: "message or images must contain content" }
  )
)

interface QueuedMessageRow {
  readonly client_id: string
  readonly message: string
  readonly images_json: string
  readonly enqueued_at: string
  readonly sent_from: "answer" | "visualization" | null
  readonly failed_reason: string | null
}

const decodeQueuedMessage = Effect.fn("SqliteChatWriteStore.decodeQueuedMessage")(function* (
  row: QueuedMessageRow,
  sessionId: string
): Effect.fn.Return<ChatQueuedMessage, ChatWriteError> {
  const images = yield* decodeJson(QueuedImagesSchema, row.images_json).pipe(
    Effect.mapError((cause) =>
      writeError("list_queued", "corrupt", "Queued images are corrupt", {
        sessionId,
        cause
      })
    )
  )
  return {
    clientId: row.client_id,
    message: row.message,
    images,
    enqueuedAt: row.enqueued_at,
    ...(row.sent_from === null ? {} : { sentFrom: row.sent_from }),
    ...(row.failed_reason === null ? {} : { failedReason: row.failed_reason })
  }
})

const loadQueuedMessage = Effect.fn("SqliteChatWriteStore.loadQueuedMessage")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  clientId: string
): Effect.fn.Return<QueuedMessageRow | null, ChatWriteError> {
  const rows = yield* sql<QueuedMessageRow>`
    SELECT client_id, message, images_json, enqueued_at, sent_from, failed_reason
    FROM session_queued_messages
    WHERE session_id = ${sessionId} AND client_id = ${clientId}
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      writeError("list_queued", "storage", "Could not read the queued message", {
        sessionId,
        cause
      })
    )
  )
  return rows[0] ?? null
})

export const claimQueued = (
  sql: SqlClient.SqlClient,
  input: { readonly sessionId: string; readonly clientId: string; readonly headOnly: boolean }
): Effect.Effect<boolean, ChatWriteError> =>
  (input.headOnly
    ? sql<{ readonly client_id: string }>`
        DELETE FROM session_queued_messages
        WHERE session_id = ${input.sessionId} AND client_id = ${input.clientId}
          AND client_id = (
            SELECT client_id FROM session_queued_messages
            WHERE session_id = ${input.sessionId}
            ORDER BY position, enqueued_at, client_id LIMIT 1)
        RETURNING client_id`
    : sql<{ readonly client_id: string }>`
        DELETE FROM session_queued_messages
        WHERE session_id = ${input.sessionId} AND client_id = ${input.clientId}
        RETURNING client_id`
  ).pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.mapError((cause) =>
      writeError("start", "storage", "Could not claim the queued message", {
        sessionId: input.sessionId,
        cause
      })
    )
  )

export const makeChatQueue = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<
  ChatWriteStore["Service"],
  | "enqueue"
  | "listQueued"
  | "cancelQueued"
  | "reorderQueued"
  | "dueQueueHeads"
  | "failQueued"
  | "onEnqueue"
> => {
  const sql = writer.sql
  const enqueueListeners = new Set<() => void>()
  const onEnqueue = (wake: () => void): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => enqueueListeners.add(wake)),
      () => Effect.sync(() => enqueueListeners.delete(wake))
    ).pipe(Effect.asVoid)
  const enqueue = Effect.fn("SqliteChatWriteStore.enqueue")(function* (
    input: ChatQueueEnqueueInput
  ): Effect.fn.Return<ChatQueuedMessage, ChatWriteFailure> {
    const valid = yield* validateInput(enqueueInputSchema, input, "enqueue")
    const imagesJson = yield* encodeJson(QueuedImagesSchema, valid.images).pipe(
      Effect.mapError((cause) =>
        writeError("enqueue", "invalid", "Queued images cannot be encoded", {
          sessionId: valid.sessionId,
          cause
        })
      )
    )
    const enqueuedAt = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          yield* loadSession(sql, valid.sessionId, "enqueue")
          const existing = yield* loadQueuedMessage(sql, valid.sessionId, valid.clientId)
          if (existing !== null) return yield* decodeQueuedMessage(existing, valid.sessionId)
          const counts = yield* sql<{ readonly queued: number }>`
          SELECT count(*) AS queued FROM session_queued_messages
          WHERE session_id = ${valid.sessionId}
        `
          if ((counts[0]?.queued ?? 0) >= CHAT_QUEUE_LIMIT) {
            return yield* new ChatWriteConflictError({
              sessionId: valid.sessionId,
              clientId: valid.clientId,
              message: `A chat can hold ${CHAT_QUEUE_LIMIT} queued messages`
            })
          }
          yield* dropPendingArchive(sql, valid.sessionId)
          yield* sql`
          INSERT INTO session_queued_messages (
            session_id, client_id, message, images_json, enqueued_at, sent_from, position
          ) SELECT ${valid.sessionId}, ${valid.clientId}, ${valid.message}, ${imagesJson}, ${enqueuedAt},
              ${valid.sentFrom ?? null},
              COALESCE(MAX(position), -1) + 1
            FROM session_queued_messages WHERE session_id = ${valid.sessionId}
        `
          return {
            clientId: valid.clientId,
            message: valid.message,
            images: valid.images,
            enqueuedAt,
            ...(valid.sentFrom === undefined ? {} : { sentFrom: valid.sentFrom })
          } satisfies ChatQueuedMessage
        })
      )
      .pipe(
        Effect.mapError(mapFailure("enqueue", { sessionId: valid.sessionId })),
        Effect.tap(() => Effect.sync(() => enqueueListeners.forEach((wake) => wake())))
      )
  })

  const listQueued = Effect.fn("SqliteChatWriteStore.listQueued")(function* (
    sessionId: string
  ): Effect.fn.Return<ReadonlyArray<ChatQueuedMessage>, ChatWriteFailure> {
    const valid = yield* validateInput(
      Schema.Struct({ sessionId: Schema.NonEmptyString }),
      { sessionId },
      "list_queued"
    )
    const rows = yield* sql<QueuedMessageRow>`
      SELECT client_id, message, images_json, enqueued_at, sent_from, failed_reason
      FROM session_queued_messages
      WHERE session_id = ${valid.sessionId}
      ORDER BY position, enqueued_at, client_id
    `.pipe(Effect.mapError(mapFailure("list_queued", { sessionId: valid.sessionId })))
    return yield* Effect.forEach(rows, (row) => decodeQueuedMessage(row, valid.sessionId))
  })

  const reorderQueued: ChatWriteStore["Service"]["reorderQueued"] = Effect.fn(function* (input) {
    const valid = yield* validateInput(
      Schema.Struct({
        sessionId: Schema.NonEmptyString,
        clientIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(CHAT_QUEUE_LIMIT))
      }),
      input,
      "reorder_queued"
    )
    if (new Set(valid.clientIds).size !== valid.clientIds.length) {
      return yield* writeError(
        "reorder_queued",
        "invalid",
        "Queued message identities must be unique"
      )
    }
    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          yield* loadSession(sql, valid.sessionId, "reorder_queued")
          const current = yield* listQueued(valid.sessionId)
          const ids = new Set(current.map((message) => message.clientId))
          if (ids.size !== valid.clientIds.length || valid.clientIds.some((id) => !ids.has(id))) {
            return yield* writeError(
              "reorder_queued",
              "invalid",
              "The queue changed; reload it before reordering"
            )
          }
          for (const [position, clientId] of valid.clientIds.entries()) {
            yield* sql`UPDATE session_queued_messages SET position = ${position}
          WHERE session_id = ${valid.sessionId} AND client_id = ${clientId}`
          }
          return yield* listQueued(valid.sessionId)
        })
      )
      .pipe(Effect.mapError(mapFailure("reorder_queued", { sessionId: valid.sessionId })))
  })

  const cancelQueued = Effect.fn("SqliteChatWriteStore.cancelQueued")(function* (input: {
    readonly sessionId: string
    readonly clientId: string
  }): Effect.fn.Return<boolean, ChatWriteFailure> {
    const valid = yield* validateInput(queuedMessageAddressSchema, input, "cancel_queued")
    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          const existing = yield* loadQueuedMessage(sql, valid.sessionId, valid.clientId)
          if (existing === null) return false
          yield* sql`
          DELETE FROM session_queued_messages
          WHERE session_id = ${valid.sessionId} AND client_id = ${valid.clientId}
        `
          return true
        })
      )
      .pipe(Effect.mapError(mapFailure("cancel_queued", { sessionId: valid.sessionId })))
  })

  const dueQueueHeads = Effect.fn("SqliteChatWriteStore.dueQueueHeads")(
    function* (): Effect.fn.Return<ReadonlyArray<ChatQueueHead>, ChatWriteFailure> {
      const retryBefore = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 }))
      const rows = yield* sql<QueuedMessageRow & { readonly session_id: string }>`
      SELECT head.session_id, head.client_id, head.message, head.images_json, head.enqueued_at,
        head.sent_from, head.failed_reason
      FROM session_queued_messages AS head
      JOIN sessions AS session ON session.session_id = head.session_id
      WHERE session.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM session_queued_messages AS earlier
          WHERE earlier.session_id = head.session_id
            AND (earlier.position, earlier.enqueued_at, earlier.client_id)
              < (head.position, head.enqueued_at, head.client_id))
        AND NOT EXISTS (
          SELECT 1 FROM chat_runs AS run
          WHERE run.session_id = head.session_id AND run.status IN ${foregroundRunStatusList})
        AND (head.failed_at IS NULL
          OR head.failed_at < ${retryBefore}
          OR EXISTS (
          SELECT 1 FROM chat_runs AS run
          WHERE run.session_id = head.session_id AND run.updated_at > head.failed_at))
      ORDER BY head.enqueued_at, head.client_id
    `.pipe(Effect.mapError(mapFailure("due_queue_heads")))
      return yield* Effect.forEach(rows, (row) =>
        decodeQueuedMessage(row, row.session_id).pipe(
          Effect.map((message) => ({ ...message, sessionId: row.session_id }))
        )
      )
    }
  )

  const failQueued = Effect.fn("SqliteChatWriteStore.failQueued")(function* (input: {
    readonly sessionId: string
    readonly clientId: string
    readonly reason: string
  }): Effect.fn.Return<void, ChatWriteFailure> {
    const valid = yield* validateInput(
      Schema.Struct({
        sessionId: Schema.NonEmptyString,
        clientId: Schema.NonEmptyString,
        reason: Schema.NonEmptyString
      }),
      input,
      "fail_queued"
    )
    const failedAt = DateTime.formatIso(yield* DateTime.now)
    yield* writer
      .transactInteractive(
        sql`UPDATE session_queued_messages
          SET failed_reason = ${valid.reason}, failed_at = ${failedAt}
          WHERE session_id = ${valid.sessionId} AND client_id = ${valid.clientId}`
      )
      .pipe(Effect.mapError(mapFailure("fail_queued", { sessionId: valid.sessionId })))
  })

  return {
    enqueue,
    listQueued,
    cancelQueued,
    reorderQueued,
    dueQueueHeads,
    failQueued,
    onEnqueue
  }
}
