import { savedBlockState } from "@arden-hq/answer-ui/state"
import { DateTime, Effect, Predicate, Schema } from "effect"
import { answerBlockBodies } from "@arden-hq/protocol/chat"
import {
  AnswerBlockStore,
  AnswerBlockStoreError,
  type SavedAnswerBlockRecord
} from "../answer-blocks/store.js"
import { JsonObjectSchema } from "../json.js"
import { decodeJson } from "./json.js"
import type { PersistenceDeps } from "./deps.js"

interface StateRow {
  readonly message_id: string
  readonly block_index: number
  readonly state_json: string
}

interface MessageRow {
  readonly role: string
  readonly message_json: string
}

const MessageEnvelopeSchema = Schema.Struct({
  content: Schema.optionalKey(Schema.Unknown),
  superseded: Schema.optionalKey(Schema.Unknown)
})

const storeError = (
  operation: "list" | "save",
  reason: "invalid" | "not_found" | "corrupt" | "storage",
  message: string,
  sessionId: string,
  cause?: unknown
): AnswerBlockStoreError =>
  new AnswerBlockStoreError({
    operation,
    reason,
    message,
    sessionId,
    ...(cause === undefined ? {} : { cause })
  })

export const makeAnswerBlockStore = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">): AnswerBlockStore["Service"] => {
  const decodeRows = Effect.fn("SqliteAnswerBlockStore.decodeRows")(function* (
    rows: ReadonlyArray<StateRow>,
    sessionId: string
  ) {
    return yield* Effect.forEach(rows, (row) =>
      decodeJson(JsonObjectSchema, row.state_json).pipe(
        Effect.map((state): SavedAnswerBlockRecord => ({
          messageId: row.message_id,
          blockIndex: row.block_index,
          state
        })),
        Effect.mapError((cause) =>
          storeError("list", "corrupt", "Saved answer block values are corrupt", sessionId, cause)
        )
      )
    )
  })

  const list = Effect.fn("SqliteAnswerBlockStore.list")(function* (sessionId: string) {
    const rows = yield* reader<StateRow>`
      SELECT message_id, block_index, state_json
      FROM answer_block_state
      WHERE session_id = ${sessionId}
    `.pipe(
      Effect.mapError((cause) =>
        storeError("list", "storage", "Could not read answer block values", sessionId, cause)
      )
    )
    return yield* decodeRows(rows, sessionId)
  })

  const forMessage = Effect.fn("SqliteAnswerBlockStore.forMessage")(function* (
    sessionId: string,
    messageId: string
  ) {
    const rows = yield* reader<StateRow>`
      SELECT message_id, block_index, state_json
      FROM answer_block_state
      WHERE session_id = ${sessionId} AND message_id = ${messageId}
    `.pipe(
      Effect.mapError((cause) =>
        storeError("list", "storage", "Could not read answer block values", sessionId, cause)
      )
    )
    const saved = yield* decodeRows(rows, sessionId)
    return new Map(saved.map((block) => [block.blockIndex, block.state]))
  })

  const save = Effect.fn("SqliteAnswerBlockStore.save")(function* (input: {
    readonly sessionId: string
    readonly messageId: string
    readonly blockIndex: number
    readonly state: Readonly<Record<string, unknown>>
  }) {
    const { sessionId, messageId, blockIndex } = input
    const fail = (
      reason: "invalid" | "not_found" | "corrupt" | "storage",
      message: string,
      cause?: unknown
    ) => storeError("save", reason, message, sessionId, cause)
    const messages = yield* reader<MessageRow>`
      SELECT role, message_json
      FROM session_messages
      WHERE session_id = ${sessionId} AND message_id = ${messageId}
      LIMIT 1
    `.pipe(Effect.mapError((cause) => fail("storage", "Could not read the message", cause)))
    const message = messages[0]
    if (message === undefined || message.role !== "assistant")
      return yield* fail("not_found", "No assistant message with this id in this chat")
    const envelope = yield* decodeJson(MessageEnvelopeSchema, message.message_json).pipe(
      Effect.mapError((cause) => fail("corrupt", "The stored message is corrupt", cause))
    )
    if (envelope.superseded === true)
      return yield* fail("not_found", "This answer was replaced by its fix")
    const body = answerBlockBodies(messageText(envelope.content))[blockIndex]
    if (body === undefined) return yield* fail("not_found", "The message has no block here")
    const kept = savedBlockState(body, input.state)
    if (kept.kind === "unreadable")
      return yield* fail("invalid", "The block is shown as code and has no values to save")
    if (kept.kind === "too_large")
      return yield* fail("invalid", "The block's values are over the size limit")
    const stateJson = JSON.stringify(kept.state)
    const state = yield* decodeJson(JsonObjectSchema, stateJson).pipe(
      Effect.mapError((cause) => fail("invalid", "The block's values are not JSON", cause))
    )
    const updatedAt = DateTime.formatIso(yield* DateTime.now)
    const written = yield* writer
      .run(
        writer.sql<{ readonly message_id: string }>`
          INSERT INTO answer_block_state (session_id, message_id, block_index, state_json, updated_at)
          SELECT ${sessionId}, ${messageId}, ${blockIndex}, ${stateJson}, ${updatedAt}
          WHERE EXISTS (
            SELECT 1 FROM session_messages
            WHERE session_id = ${sessionId} AND message_id = ${messageId}
              AND json_extract(message_json, '$.superseded') IS NOT 1
          )
          ON CONFLICT (session_id, message_id, block_index) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = excluded.updated_at
          RETURNING message_id
        `
      )
      .pipe(Effect.mapError((cause) => fail("storage", "Could not save the block's values", cause)))
    if (written.length === 0) return yield* fail("not_found", "The message is gone or replaced")
    return { messageId, blockIndex, state }
  })

  return AnswerBlockStore.of({ list, forMessage, save })
}

const messageText = (content: unknown): string => {
  if (Predicate.isString(content)) return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(Predicate.isObject)
    .flatMap((part) => (Predicate.isString(part.text) ? [part.text] : []))
    .join("\n\n")
}
