import { Effect, Schema } from "effect"
import { SessionStoreError } from "../sessions/store.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { decodeJson } from "./json.js"

export interface BranchMessageRow {
  readonly seq: number
  readonly message_id: string
  readonly role: string
  readonly message_json: string
  readonly client_id: string | null
  readonly created_at: string
}

export const OptionalInputTokens = Schema.NullOr(Schema.Natural)

const MessageListSchema = Schema.Array(StoredMessageEnvelopeSchema)

export const messageListEquivalent = Schema.toEquivalence(MessageListSchema)

export const storeError = (
  operation:
    | "list"
    | "list_archived"
    | "create"
    | "branch"
    | "rename"
    | "move"
    | "archive"
    | "restore"
    | "continue"
    | "delete"
    | "clear"
    | "revert"
    | "triage"
    | "capture",
  reason: "invalid" | "not_found" | "conflict" | "storage",
  message: string,
  sessionId?: string,
  cause?: unknown
): SessionStoreError =>
  new SessionStoreError({
    operation,
    reason,
    message,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cause === undefined ? {} : { cause })
  })

export const sessionIdSchema = Schema.NonEmptyString

export const sessionNameSchema = Schema.Trimmed.check(Schema.isMinLength(1))

export const decodeTranscriptRow = Effect.fn("SqliteSessionStore.decodeTranscriptRow")(function* (
  row: BranchMessageRow,
  context: {
    readonly operation: "branch" | "clear" | "revert"
    readonly sessionId: string
    readonly label: "Source transcript" | "Session transcript"
  }
): Effect.fn.Return<StoredMessageEnvelope, SessionStoreError> {
  const { operation, sessionId, label } = context
  const message = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json).pipe(
    Effect.mapError((cause) =>
      storeError(operation, "storage", `${label} message is corrupt`, sessionId, cause)
    )
  )
  const clientId = yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.NonEmptyString))(
    message.client_id ?? null
  ).pipe(
    Effect.mapError((cause) =>
      storeError(operation, "storage", `${label} client id is corrupt`, sessionId, cause)
    )
  )
  if (
    row.message_id !== message.message_id ||
    row.role !== message.role ||
    row.client_id !== clientId ||
    row.created_at !== message.created_at
  ) {
    return yield* storeError(
      operation,
      "storage",
      `${label} row disagrees with its message`,
      sessionId
    )
  }
  return message
})
