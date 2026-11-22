import { ROLE } from "@arden-hq/std/message-vocabulary"
import { sha256Hex } from "@arden-hq/std/hash"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { TaskInferencePolicySchema } from "@arden-hq/protocol/effect/spaces"
import { Clock, Effect, Option, Schema } from "effect"
import { nextOutboxAttemptAt } from "../../runtime/outbox.js"
import { iso } from "../../runtime/clock.js"
import {
  PostTaskPartsSchema,
  postTaskParts,
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
import { jobMayPublish } from "./automation-lease.js"
import { recordAutomationPosted } from "./entity-events.js"
import { mainSpaceId } from "./main-space.js"
import { messageQuote } from "./message-quote.js"
import { chatHasActiveWork } from "./session-archive.js"
import { eventThreadLiveSql } from "./event-thread-live.js"
import { decodeJson } from "./json.js"
import { liftChat } from "./session-unread.js"
import { ensureSpaceConversationInTransaction } from "./space-conversation.js"
import { makeWorkCaptureSql } from "./work-capture.js"
import { makeWorkEvents } from "./work-events.js"

interface ThreadHit {
  readonly session_id: string
}

interface DeliveryRow {
  readonly payload: string
}

type Withdrawal = (typeof POST_WITHDRAWAL_REASONS)[number]

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(PostDeliveryPayloadSchema))
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(PostDeliveryPayloadSchema))

export const postDeliveryId = (attemptId: number): string => sha256Hex(`post:${attemptId}`)

const POST_ATTEMPTS = 10

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

  const threadHit = (threads: string) =>
    sql<ThreadHit>`
      SELECT mapped.session_id
      FROM event_threads AS mapped
      JOIN json_each(${threads}) AS thread
        ON mapped.source = json_extract(thread.value, '$.source')
       AND mapped.account = json_extract(thread.value, '$.account')
       AND mapped.thread_key = json_extract(thread.value, '$.thread_key')
      WHERE ${eventThreadLiveSql(sql, "mapped")}
      ORDER BY mapped.updated_at DESC
      LIMIT 1`

  const threadsOf = (itemIds: ReadonlyArray<string>) =>
    sql<{ readonly source: string; readonly account: string; readonly thread_key: string }>`
      SELECT DISTINCT source, account, thread_key FROM connection_item_threads
      WHERE item_id IN (SELECT value FROM json_each(${JSON.stringify(itemIds)}))`.pipe(
      Effect.map((rows) => JSON.stringify(rows))
    )

  const threadMatch = (threads: string, mapped: string) => sql`${sql(mapped)}.source IN (
    SELECT json_extract(thread.value, '$.source') FROM json_each(${threads}) AS thread
    WHERE json_extract(thread.value, '$.account') = ${sql(mapped)}.account
      AND json_extract(thread.value, '$.thread_key') = ${sql(mapped)}.thread_key)`

  const queueOnThreads = (
    threads: string,
    post: {
      readonly sessionId: string
      readonly messageId: string
      readonly deliveryId: string
      readonly at: string
    }
  ) => sql`
    INSERT INTO event_threads (source, account, thread_key, session_id, message_id,
      delivery_id, updated_at)
    SELECT json_extract(thread.value, '$.source'), json_extract(thread.value, '$.account'),
      json_extract(thread.value, '$.thread_key'), ${post.sessionId}, ${post.messageId},
      ${post.deliveryId}, ${post.at}
    FROM json_each(${threads}) AS thread
    WHERE true
    ON CONFLICT (source, account, thread_key) DO UPDATE SET
      session_id = excluded.session_id, message_id = excluded.message_id,
      delivery_id = excluded.delivery_id, updated_at = excluded.updated_at
    WHERE NOT ${eventThreadLiveSql(sql, "event_threads")}`

  const rootOnThreads = (
    threads: string,
    post: {
      readonly sessionId: string
      readonly messageId: string
      readonly deliveryId: string
      readonly at: string
    }
  ) => sql`
    UPDATE event_threads AS mapped
    SET session_id = ${post.sessionId}, message_id = ${post.messageId},
      delivery_id = ${post.deliveryId}, updated_at = ${post.at}
    WHERE ${threadMatch(threads, "mapped")} AND NOT ${eventThreadLiveSql(sql, "mapped")}`

  const parentOf = (
    threads: string,
    post: { readonly sessionId: string; readonly messageId: string }
  ) =>
    sql<{ readonly message_id: string }>`
      SELECT mapped.message_id FROM event_threads AS mapped
      JOIN json_each(${threads}) AS thread
        ON mapped.source = json_extract(thread.value, '$.source')
       AND mapped.account = json_extract(thread.value, '$.account')
       AND mapped.thread_key = json_extract(thread.value, '$.thread_key')
      WHERE mapped.session_id = ${post.sessionId} AND mapped.message_id <> ${post.messageId}
        AND EXISTS (SELECT 1 FROM session_messages AS message
          WHERE message.session_id = mapped.session_id AND message.message_id = mapped.message_id)
      ORDER BY mapped.updated_at DESC
      LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.message_id))

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
          if (
            !(yield* jobMayPublish(sql, {
              lease: input.lease,
              automationId: input.automationId,
              attemptId: input.attemptId
            }))
          )
            return yield* new PostStoreError({
              reason: "conflict",
              message:
                "The run's job is no longer current or its Automation is paused, so nothing was posted"
            })
          const now = iso(yield* Clock.currentTimeMillis)
          const threads = yield* threadsOf(input.itemIds)
          const hit = (yield* threadHit(threads))[0]
          const place =
            hit === undefined ? yield* spaceChat(input.spaceId) : { sessionId: hit.session_id }
          yield* queueOnThreads(threads, {
            sessionId: place.sessionId,
            messageId,
            deliveryId,
            at: now
          })
          const payload: PostDeliveryPayload = {
            kind: "post",
            automationId: input.automationId,
            runId: input.runId,
            sessionId: place.sessionId,
            messageId,
            text: input.text,
            itemIds: [...input.itemIds],
            ...(input.task === undefined ? {} : { task: input.task })
          }
          if (payload.task !== undefined)
            yield* Schema.decodeUnknownEffect(PostTaskPartsSchema)(
              postTaskParts(payload, payload.task)
            ).pipe(
              Effect.mapError(
                (cause) => new PostStoreError({ reason: "invalid", message: "Invalid post", cause })
              )
            )
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
          WHERE earlier.status = 'pending' AND earlier.rowid < delivery.rowid
            AND json_extract(earlier.payload, '$.kind') = 'post'
            AND json_extract(earlier.payload, '$.sessionId') =
              json_extract(delivery.payload, '$.sessionId'))
      ORDER BY delivery.rowid LIMIT 32`.pipe(
      Effect.mapError(storage("Could not read pending posts"))
    )
    return rows.map((row) => ({ deliveryId: row.delivery_id, attempt: row.attempt_count }))
  })

  const withdraw = (deliveryId: string, reason: Withdrawal, at: string) =>
    sql`UPDATE automation_deliveries SET status = 'discarded',
        payload = json_set(COALESCE(json(payload), '{}'), '$.withdrawal',
          json_object('at', ${at}, 'reason', ${reason}))
      WHERE delivery_id = ${deliveryId} AND status = 'pending'`

  const inferenceOn = Effect.fn("PostStore.inferenceOn")(function* (spaceId: string) {
    const row = (yield* sql<{ readonly inference_policy: string }>`
      SELECT inference_policy FROM spaces WHERE space_id = ${spaceId}`)[0]
    if (row === undefined) return false
    const policy = yield* Effect.option(decodeJson(TaskInferencePolicySchema, row.inference_policy))
    return Option.isSome(policy) && policy.value.enabled
  })

  const createTask = Effect.fn("PostStore.createTask")(function* (
    payload: PostDeliveryPayload,
    spaceId: string
  ) {
    const task = payload.task
    if (task === undefined) return
    if (!(yield* inferenceOn(spaceId))) return
    if (yield* threadTaken(sql, { itemIds: payload.itemIds, exceptProposal: undefined })) return
    const scope = { kind: "space", spaceId } as const
    const parts = postTaskParts(payload, task)
    yield* work.createInTransaction({
      scope,
      input: { ...parts.input, key: yield* work.freeKey(scope, task.title) },
      actor: "worker",
      taskSources: parts.taskSources,
      capture: parts.capture,
      causedBy: payload.runId,
      originMessageId: payload.messageId
    })
  })

  const deliverInTransaction = Effect.fn("PostStore.deliverInTransaction")(function* (
    deliveryId: string
  ) {
    const row = (yield* sql<DeliveryRow>`
      SELECT payload FROM automation_deliveries
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
    const threads = yield* threadsOf(payload.itemIds)
    const parent = yield* parentOf(threads, payload)
    const quote =
      parent === undefined
        ? undefined
        : yield* messageQuote(sql, { sessionId: payload.sessionId, messageId: parent })
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
    yield* rootOnThreads(threads, {
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      deliveryId,
      at: now
    })
    yield* recordAutomationPosted(sql, {
      sessionEvents,
      automationId: payload.automationId,
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
    const now = yield* Clock.currentTimeMillis
    yield* writer
      .run(
        attempt >= POST_ATTEMPTS
          ? sql`UPDATE automation_deliveries SET status = 'discarded',
              attempt_count = ${attempt}, last_error = ${cause},
              payload = json_set(COALESCE(json(payload), '{}'), '$.withdrawal',
                json_object('at', ${iso(now)}, 'reason', 'undeliverable'))
            WHERE delivery_id = ${delivery.deliveryId} AND status = 'pending'
              AND attempt_count = ${delivery.attempt}`
          : sql`UPDATE automation_deliveries SET
              attempt_count = ${attempt}, next_attempt_at = ${nextOutboxAttemptAt(now, attempt)},
              last_error = ${cause}
            WHERE delivery_id = ${delivery.deliveryId} AND status = 'pending'
              AND attempt_count = ${delivery.attempt}`
      )
      .pipe(Effect.mapError(storage("Could not schedule the post retry")))
  })

  return PostStore.of({ post, pendingDeliveries, deliver, defer })
}
