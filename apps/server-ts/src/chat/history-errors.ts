import { Schema } from "effect"
import type { ChatEventStoreError } from "../persistence/events/store.js"
import type { RunQueryFailure } from "../persistence/runs/queries.js"
import type { SessionQueryFailure } from "../persistence/sessions/queries.js"
import type { ToolExecutionStoreError } from "../persistence/tools/store.js"
import type { TranscriptQueryFailure } from "../persistence/transcript/queries.js"
import type { SessionTurnQueryError } from "../persistence/turns/queries.js"

export class ChatSessionNotFound extends Schema.TaggedError<ChatSessionNotFound>()(
  "ChatSessionNotFound",
  {
    sessionId: Schema.NonEmptyString
  }
) {}

export class ChatHistoryError extends Schema.TaggedError<ChatHistoryError>()("ChatHistoryError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class ChatHistoryInvalidCursor extends Schema.TaggedError<ChatHistoryInvalidCursor>()(
  "ChatHistoryInvalidCursor",
  {
    sessionId: Schema.NonEmptyString,
    cursor: Schema.NonEmptyString
  }
) {}

export class ChatTurnNotFound extends Schema.TaggedError<ChatTurnNotFound>()("ChatTurnNotFound", {
  sessionId: Schema.NonEmptyString,
  turnId: Schema.NonEmptyString
}) {}

export type ChatHistoryFailure =
  | ChatSessionNotFound
  | ChatHistoryInvalidCursor
  | ChatTurnNotFound
  | ChatHistoryError
  | SessionQueryFailure
  | RunQueryFailure
  | TranscriptQueryFailure
  | SessionTurnQueryError
  | ChatEventStoreError
  | ToolExecutionStoreError
