import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { ChatProjectionEventSchema } from "@arden-hq/protocol/effect/chat"
import { type JournalRecord, type JournalEvent } from "@arden-hq/journal/effect"
import { Effect, Schema } from "effect"
import { ChatEventStoreError, type ChatEventOperation } from "../events/store.js"
import { type SessionEventRecord } from "../events/model.js"
import { decodeStoredChatEvent } from "../events/stored-chat-event.js"

export const eventError = (
  operation: ChatEventOperation,
  message: string,
  cause?: unknown
): ChatEventStoreError =>
  new ChatEventStoreError({ operation, message, ...(cause === undefined ? {} : { cause }) })

export type ChatEventErrorMapper = (cause: unknown) => ChatEventStoreError

export const mapError =
  (operation: ChatEventOperation, message: string): ChatEventErrorMapper =>
  (cause: unknown) =>
    cause instanceof ChatEventStoreError ? cause : eventError(operation, message, cause)

export const decodeRecord = Effect.fn("SqliteChatEventStore.decodeRecord")(function* (
  record: JournalRecord,
  operation: "read" | "follow"
): Effect.fn.Return<SessionEventRecord, ChatEventStoreError> {
  const event = yield* decodeStoredChatEvent(record.data, record.streamId).pipe(
    Effect.mapError((cause) => eventError(operation, "Stored Chat event is corrupt", cause))
  )
  if (event.type !== record.type) {
    return yield* eventError(operation, "Stored Chat event type does not match its payload")
  }
  const createdAt = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
    record.createdAt
  ).pipe(
    Effect.mapError((cause) =>
      eventError(operation, "Stored Chat event timestamp is corrupt", cause)
    )
  )
  const attribute = record.attributes.runId
  if (attribute !== undefined && (typeof attribute !== "string" || attribute.length === 0)) {
    return yield* eventError(operation, "Stored Chat event runId is corrupt")
  }
  return {
    sessionId: record.streamId,
    sequence: record.sequence,
    event,
    createdAt,
    durable: record.durable,
    ...(attribute === undefined ? {} : { runId: attribute })
  }
})

const encodeChatEvent = Schema.encodeEffect(Schema.toCodecJson(ChatProjectionEventSchema))

export const journalDraft = (
  event: ChatProjectionEvent,
  runId: string | null | undefined,
  durable: boolean
): Effect.Effect<JournalEvent, ChatEventStoreError> =>
  encodeChatEvent(event).pipe(
    Effect.map((data) => ({
      type: event.type,
      data,
      attributes: runId === undefined || runId === null ? {} : { runId },
      durable
    })),
    Effect.mapError((cause) => eventError("append", "Chat event cannot be encoded", cause))
  )
