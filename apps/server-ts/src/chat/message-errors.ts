import { Schema } from "effect"
import { ChatWriteConflictError, type ChatWriteError } from "../persistence/chat/store.js"
import type { ToolExecutionStoreError } from "../persistence/tools/store.js"

export const CHAT_MESSAGE_FAILURE = {
  invalid: "invalid",
  conflict: "conflict",
  unavailable: "unavailable",
  not_found: "not_found",
  storage: "storage",
  runner: "runner"
} as const

export class ChatMessageError extends Schema.TaggedError<ChatMessageError>()("ChatMessageError", {
  reason: Schema.Literals(Object.values(CHAT_MESSAGE_FAILURE)),
  message: Schema.String,
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export const CHAT_CONFLICT_KIND = {
  sessionBusy: "session_busy",
  taskIdle: "task_idle",
  queueChanged: "queue_changed"
} as const

export class ChatMessageConflictError extends Schema.TaggedError<ChatMessageConflictError>()(
  "ChatMessageConflictError",
  {
    sessionId: Schema.NonEmptyString,
    clientId: Schema.NonEmptyString,
    message: Schema.String,
    kind: Schema.optionalKey(Schema.Literals(Object.values(CHAT_CONFLICT_KIND)))
  }
) {}

export type ChatMessageFailure = ChatMessageError | ChatMessageConflictError

export class StoredMessageDecodeError extends Schema.TaggedError<StoredMessageDecodeError>()(
  "StoredMessageDecodeError",
  {
    sessionId: Schema.NonEmptyString,
    messageId: Schema.NonEmptyString,
    position: Schema.Int,
    message: Schema.String
  }
) {}

const WRITE_ERROR_REASON: Readonly<
  Record<
    ChatWriteError["reason"],
    | typeof CHAT_MESSAGE_FAILURE.not_found
    | typeof CHAT_MESSAGE_FAILURE.invalid
    | typeof CHAT_MESSAGE_FAILURE.storage
  >
> = {
  not_found: CHAT_MESSAGE_FAILURE.not_found,
  invalid: CHAT_MESSAGE_FAILURE.invalid,
  terminal: CHAT_MESSAGE_FAILURE.invalid,
  corrupt: CHAT_MESSAGE_FAILURE.storage,
  storage: CHAT_MESSAGE_FAILURE.storage
}

const writeErrorReason = (reason: ChatWriteError["reason"]) => WRITE_ERROR_REASON[reason]

export const mapWriteError = (
  error: ChatWriteError | ChatWriteConflictError
): ChatMessageFailure =>
  error instanceof ChatWriteConflictError
    ? new ChatMessageConflictError({
        sessionId: error.sessionId,
        clientId: error.clientId,
        message: error.message,
        ...(error.kind === undefined ? {} : { kind: error.kind })
      })
    : new ChatMessageError({
        reason: writeErrorReason(error.reason),
        message: error.message,
        ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
        ...(error.cause === undefined ? {} : { cause: error.cause })
      })

const TOOL_STORE_ERROR_REASON: Readonly<
  Record<
    ToolExecutionStoreError["reason"],
    | typeof CHAT_MESSAGE_FAILURE.invalid
    | typeof CHAT_MESSAGE_FAILURE.not_found
    | typeof CHAT_MESSAGE_FAILURE.conflict
    | typeof CHAT_MESSAGE_FAILURE.storage
  >
> = {
  invalid: CHAT_MESSAGE_FAILURE.invalid,
  not_found: CHAT_MESSAGE_FAILURE.not_found,
  conflict: CHAT_MESSAGE_FAILURE.conflict,
  blocked: CHAT_MESSAGE_FAILURE.conflict,
  corrupt: CHAT_MESSAGE_FAILURE.storage,
  storage: CHAT_MESSAGE_FAILURE.storage
}

const toolStoreErrorReason = (reason: ToolExecutionStoreError["reason"]) =>
  TOOL_STORE_ERROR_REASON[reason]

export const mapToolStoreError = (error: ToolExecutionStoreError): ChatMessageError =>
  new ChatMessageError({
    reason: toolStoreErrorReason(error.reason),
    message: error.message,
    ...(error.cause === undefined ? {} : { cause: error.cause })
  })
