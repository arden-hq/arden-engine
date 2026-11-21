import { ROLE } from "@arden-hq/std/message-vocabulary"
import { sha256Hex } from "@arden-hq/std/hash"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { Clock, Effect, Option, Schema } from "effect"
import { nextOutboxAttemptAt } from "../../runtime/outbox.js"
import { iso } from "../../runtime/clock.js"
import {
  PostDeliveryPayloadSchema,
  type PostDeliveryPayload,
  POST_WITHDRAWAL_REASONS
} from "../posts/model.js"
import { PostStore, PostStoreError, type PostInput, type PostedMessage } from "../posts/store.js"
import { SessionStoreError } from "../sessions/store.js"
import type { StoredMessageEnvelope } from "../transcript/model.js"
import type { PersistenceDeps } from "./deps.js"
import { appendMessagesInTransaction } from "./chat-transcript.js"
import { threadTaken } from "./connection-item-evidence.js"
import { recordAutomationPosted } from "./entity-events.js"
import { mainSpaceId } from "./main-space.js"
import { messageQuote } from "./message-quote.js"
import { chatHasActiveWork } from "./session-archive.js"
import { liftChat } from "./session-unread.js"
import { ensureSpaceConversationInTransaction } from "./space-conversation.js"
import { makeWorkCaptureSql } from "./work-capture.js"
import { makeWorkEvents } from "./work-events.js"

interface ThreadHit {
  readonly session_id: string
  readonly message_id: string
  readonly delivery_id: string
}

interface DeliveryRow {
  readonly task_id: string | null
  readonly payload: string
}

type Withdrawal = (typeof POST_WITHDRAWAL_REASONS)[number]

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(PostDeliveryPayloadSchema))
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(PostDeliveryPayloadSchema))

export const postDeliveryId = (attemptId: number): string => sha256Hex(`post:${attemptId}`)

const postMessageId = (deliveryId: string): string => `post:${deliveryId}`

const storage = (message: string) => (cause: unknown) =>
  cause instanceof PostStoreError
    ? cause
    : new PostStoreError({ reason: "storage", message, cause })

export const makePostStore = ({
  writer,
  chatEvents,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">): PostStore["Service"] => {
  const sql = writer.sql
  const work = makeWorkCaptureSql({ writer, sessionEvents, ...makeWorkEvents(sql, sessionEvents) })

  const existing = Effect.fn("PostStore.existing")(function* (deliveryId: string) {
    const rows = yield* sql<{ readonly payload: string }>`
      SELECT payload FROM automation_deliveries WHERE delivery_id = ${deliveryId}`
    const row = rows[0]
    if (row === undefined) return undefined
    const payload = decodePayload(row.payload)
    if (Option.isNone(payload))
      return yield* new PostStoreError({ reason: "storage", message: "Stored post is corrupt" })
    return {
      sessionId: payload.value.sessionId,
      messageId: payload.value.messageId
    } satisfies PostedMessage
  })

  const liveMapping = (mapped: string) => sql`(
    EXISTS (SELECT 1 FROM sessions AS chat
      WHERE chat.session_id = ${sql(mapped)}.session_id
        AND chat.archived_at IS NULL AND chat.space_id IS NOT NULL)
    AND (EXISTS (SELECT 1 FROM session_messages AS message
          WHERE message.session_id = ${sql(mapped)}.session_id
            AND message.message_id = ${sql(mapped)}.message_id)
      OR EXISTS (SELECT 1 FROM automation_deliveries AS earlier
          WHERE earlier.delivery_id = ${sql(mapped)}.delivery_id AND earlier.status = 'pending')))`

  const threadHit = (threads: string) =>
    sql<ThreadHit>`
      SELECT mapped.session_id, mapped.message_id, mapped.delivery_id
      FROM event_threads AS mapped
      JOIN json_each(${threads}) AS thread
        ON mapped.source = json_extract(thread.value, '$.source')
       AND mapped.account = json_extract(thread.value, '$.account')
       AND mapped.thread_key = json_extract(thread.value, '$.thread_key')
      WHERE ${liveMapping("mapped")}
      ORDER BY mapped.updated_at DESC
      LIMIT 1`

  const spaceChat = Effect.fn("PostStore.spaceChat")(function* (spaceId: string | undefined) {
    const named =
      spaceId === undefined
        ? undefined
        : yield* ensureSpaceConversationInTransaction({ sql, sessionEvents, spaceId }).pipe(
            Effect.map((sessionId) => ({ sessionId })),
            Effect.catchIf(
              (error) => error instanceof SessionStoreError && error.reason === "not_found",
              () => Effect.succeed(undefined)
            )
          )
    if (named !== undefined) return named
    const main = yield* mainSpaceId(sql)
    return {
      sessionId: yield* ensureSpaceConversationInTransaction({ sql, sessionEvents, spaceId: main })
    }
  })

  const post = Effect.fn("PostStore.post")(function* (
    input: PostInput
  ): Effect.fn.Return<PostedMessage, PostStoreError> {
    const deliveryId = postDeliveryId(input.attemptId)
    const messageId = postMessageId(deliveryId)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const found = yield* existing(deliveryId)
          if (found !== undefined) return found
          const now = iso(yield* Clock.currentTimeMillis)
          const threads = JSON.stringify(
            yield* sql<{
              readonly source: string
              readonly account: string
              readonly thread_key: string
            }>`
              SELECT DISTINCT source, account, thread_key FROM connection_item_threads
              WHERE item_id IN (SELECT value FROM json_each(${JSON.stringify(input.itemIds)}))`
          )
          const hit = (yield* threadHit(threads))[0]
          const place =
            hit === undefined ? yield* spaceChat(input.spaceId) : { sessionId: hit.session_id }
          yield* sql`
            INSERT INTO event_threads (source, account, thread_key, session_id, message_id,
              delivery_id, updated_at)
            SELECT json_extract(thread.value, '$.source'), json_extract(thread.value, '$.account'),
              json_extract(thread.value, '$.thread_key'), ${place.sessionId}, ${messageId},
              ${deliveryId}, ${now}
            FROM json_each(${threads}) AS thread
            WHERE true
            ON CONFLICT (source, account, thread_key) DO UPDATE SET
              session_id = excluded.session_id, message_id = excluded.message_id,
              delivery_id = excluded.delivery_id,
              updated_at = excluded.updated_at
            WHERE NOT ${liveMapping("event_threads")}`
          const payload: PostDeliveryPayload = {
            kind: "post",
            runId: input.runId,
            sessionId: place.sessionId,
            messageId,
            text: input.text,
            ...(hit === undefined
              ? {}
              : { replyTo: { messageId: hit.message_id, deliveryId: hit.delivery_id } }),
            ...(input.task === undefined
              ? {}
              : { task: { ...input.task, itemIds: [...input.itemIds] } })
          }
          yield* sql`INSERT INTO automation_deliveries (
              delivery_id, task_id, delivered_at, subject, body, payload, status, created_at,
              destinations
            ) VALUES (
              ${deliveryId}, ${input.automationId}, NULL, 'post', ${input.text},
              ${yield* encodePayload(payload).pipe(
                Effect.mapError(
                  (cause) =>
                    new PostStoreError({ reason: "invalid", message: "Invalid post", cause })
                )
              )}, 'pending', ${now}, '[]'
            )`
          return { sessionId: place.sessionId, messageId }
        })
      )
      .pipe(Effect.mapError(storage("Could not post the message")))
  })

  const pendingDeliveries = Effect.fn("PostStore.pendingDeliveries")(function* () {
    const now = iso(yield* Clock.currentTimeMillis)
    const rows = yield* sql<{ readonly delivery_id: string; readonly attempt_count: number }>`
      SELECT delivery.delivery_id, delivery.attempt_count
      FROM automation_deliveries AS delivery
      LEFT JOIN sessions AS chat
        ON chat.session_id = json_extract(delivery.payload, '$.sessionId')
      WHERE delivery.status = 'pending' AND json_extract(delivery.payload, '$.kind') = 'post'
        AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= ${now})
        AND (chat.session_id IS NULL OR NOT ${chatHasActiveWork(sql, sql`chat`)})
        AND NOT EXISTS (SELECT 1 FROM automation_deliveries AS earlier
          WHERE earlier.delivery_id = json_extract(delivery.payload, '$.replyTo.deliveryId')
            AND earlier.status = 'pending')
      ORDER BY delivery.created_at, delivery.delivery_id LIMIT 32`.pipe(
      Effect.mapError(storage("Could not read pending posts"))
    )
    return rows.map((row) => ({ deliveryId: row.delivery_id, attempt: row.attempt_count }))
  })

  const withdraw = (deliveryId: string, reason: Withdrawal, at: string) =>
    sql`UPDATE automation_deliveries SET status = 'discarded',
        payload = json_set(COALESCE(json(payload), '{}'), '$.withdrawal',
          json_object('at', ${at}, 'reason', ${reason}))
      WHERE delivery_id = ${deliveryId} AND status = 'pending'`

  const createTask = Effect.fn("PostStore.createTask")(function* (
    payload: PostDeliveryPayload,
    spaceId: string
  ) {
    const task = payload.task
    if (task === undefined) return
    if (yield* threadTaken(sql, { itemIds: task.itemIds, exceptProposal: undefined })) return
    const scope = { kind: "space", spaceId } as const
    yield* work.createInTransaction({
      scope,
      input: { key: yield* work.freeKey(scope, task.title), text: task.title, body: task.brief },
      actor: "worker",
      taskSources: [
        {
          kind: "chat",
          session_id: payload.sessionId,
          turn_id: payload.messageId,
          revision: payload.messageId
        },
        ...task.itemIds.map((itemId) => ({
          kind: "connection_item" as const,
          item_id: itemId,
          revision: itemId
        }))
      ],
      capture: { basis: "explicit", reason: payload.text },
      causedBy: payload.runId,
      originMessageId: payload.messageId
    })
  })

  const deliverInTransaction = Effect.fn("PostStore.deliverInTransaction")(function* (
    deliveryId: string
  ) {
    const row = (yield* sql<DeliveryRow>`
      SELECT task_id, payload FROM automation_deliveries
      WHERE delivery_id = ${deliveryId} AND status = 'pending'`)[0]
    if (row === undefined) return false
    const now = iso(yield* Clock.currentTimeMillis)
    const decoded = decodePayload(row.payload)
    if (Option.isNone(decoded)) {
      yield* withdraw(deliveryId, "undecodable", now)
      return false
    }
    const payload = decoded.value
    const chat = (yield* sql<{
      readonly archived_at: string | null
      readonly space_id: string | null
      readonly busy: number
    }>`
      SELECT chat.archived_at, chat.space_id, ${chatHasActiveWork(sql, sql`chat`)} AS busy
      FROM sessions AS chat WHERE chat.session_id = ${payload.sessionId}`)[0]
    if (chat === undefined) {
      yield* withdraw(deliveryId, "destination_deleted", now)
      return false
    }
    if (chat.archived_at !== null) {
      yield* withdraw(deliveryId, "destination_archived", now)
      return false
    }
    if (chat.busy === 1) return false
    const quote =
      payload.replyTo === undefined
        ? undefined
        : yield* messageQuote(sql, {
            sessionId: payload.sessionId,
            messageId: payload.replyTo.messageId
          })
    const message: StoredMessageEnvelope = {
      message_id: payload.messageId,
      role: ROLE.assistant,
      content: payload.text,
      created_at: now,
      ...(quote === undefined ? {} : { replyTo: quote })
    }
    yield* appendMessagesInTransaction(
      sql,
      payload.sessionId,
      [message],
      now,
      "post",
      payload.messageId
    )
    yield* liftChat(sql, sessionEvents, { sessionId: payload.sessionId, at: now })
    yield* sql`UPDATE automation_deliveries SET status = 'delivered', delivered_at = ${now},
        destinations = ${JSON.stringify([`chat:${payload.sessionId}`])},
        next_attempt_at = NULL, last_error = NULL
      WHERE delivery_id = ${deliveryId} AND status = 'pending'`
    yield* chatEvents.appendInTransaction({
      sessionId: payload.sessionId,
      events: [{ event: { type: "transcript_changed" } satisfies ChatProjectionEvent }]
    })
    if (row.task_id !== null)
      yield* recordAutomationPosted(sql, {
        sessionEvents,
        automationId: row.task_id,
        key: payload.messageId,
        sessionId: payload.sessionId,
        text: payload.text,
        occurredAt: now
      })
    if (chat.space_id !== null) yield* createTask(payload, chat.space_id)
    return true
  })

  const deliver = Effect.fn("PostStore.deliver")(function* (delivery: {
    readonly deliveryId: string
  }) {
    return yield* writer
      .transact(deliverInTransaction(delivery.deliveryId))
      .pipe(Effect.mapError(storage("Could not deliver the post")))
  })

  const defer = Effect.fn("PostStore.defer")(function* (
    delivery: { readonly deliveryId: string; readonly attempt: number },
    cause: string
  ) {
    const attempt = delivery.attempt + 1
    const retryAt = nextOutboxAttemptAt(yield* Clock.currentTimeMillis, attempt)
    yield* writer
      .run(
        sql`UPDATE automation_deliveries SET
          attempt_count = ${attempt}, next_attempt_at = ${retryAt}, last_error = ${cause}
        WHERE delivery_id = ${delivery.deliveryId} AND status = 'pending'
          AND attempt_count = ${delivery.attempt}`
      )
      .pipe(Effect.mapError(storage("Could not schedule the post retry")))
  })

  return PostStore.of({ post, pendingDeliveries, deliver, defer })
}
