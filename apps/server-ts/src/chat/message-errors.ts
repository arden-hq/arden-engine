import { Schema } from "effect"
import { ChatWriteConflictError, type ChatWriteError } from "../persistence/chat/store.js"
import type { ToolExecutionStoreError } from "../persistence/tools/store.js"

export class ChatMessageError extends Schema.TaggedError<ChatMessageError>()("ChatMessageError", {
  reason: Schema.Literals([
    "invalid",
    "conflict",
    "unavailable",
    "not_found",
    "storage",
    "runner"
  ] as const),
  message: Schema.String,
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class ChatMessageConflictError extends Schema.TaggedError<ChatMessageConflictError>()(
  "ChatMessageConflictError",
  {
    sessionId: Schema.NonEmptyString,
    clientId: Schema.NonEmptyString,
    message: Schema.String,
    kind: Schema.optionalKey(Schema.Literals(["session_busy", "task_idle", "queue_changed"]))
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

const writeErrorReason = (reason: ChatWriteError["reason"]) => {
  switch (reason) {
    case "not_found":
    case "invalid":
      return reason
    case "terminal":
      return "invalid" as const
    case "corrupt":
    case "storage":
      return "storage" as const
  }
}

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

const toolStoreErrorReason = (reason: ToolExecutionStoreError["reason"]) => {
  switch (reason) {
    case "invalid":
    case "not_found":
      return reason
    case "conflict":
    case "blocked":
      return "conflict" as const
    case "corrupt":
    case "storage":
      return "storage" as const
  }
}

export const mapToolStoreError = (error: ToolExecutionStoreError): ChatMessageError =>
  new ChatMessageError({
    reason: toolStoreErrorReason(error.reason),
    message: error.message,
    ...(error.cause === undefined ? {} : { cause: error.cause })
  })
