import { HttpApiError } from "effect/unstable/httpapi"
import {
  ChatHistoryInvalidCursor,
  ChatSessionNotFound,
  ChatTurnNotFound,
  type ChatHistoryFailure
} from "../../chat/history-errors.js"
import {
  CHAT_MESSAGE_FAILURE,
  ChatMessageConflictError,
  type ChatMessageError,
  type ChatMessageFailure
} from "../../chat/message-errors.js"
import { CONNECTION_CHECK_FAILURE, type ConnectionCheckError } from "../../connections/recovery.js"
import {
  CHAT_WRITE_FAILURE,
  ChatWriteConflictError,
  type ChatWriteError,
  type ChatWriteFailure
} from "../../persistence/chat/store.js"
import { TOOL_STORE_FAILURE, type ToolExecutionStoreError } from "../../persistence/tools/store.js"
import { StoreConflict, StoreInvalid, storeErrorToHttp, type StoreReasonHttp } from "../errors.js"

export const historyError = (
  error: ChatHistoryFailure
): HttpApiError.BadRequest | HttpApiError.NotFound | HttpApiError.InternalServerError => {
  if (error instanceof ChatHistoryInvalidCursor) return new HttpApiError.BadRequest({})
  if (error instanceof ChatSessionNotFound || error instanceof ChatTurnNotFound) {
    return new HttpApiError.NotFound({})
  }
  return new HttpApiError.InternalServerError({})
}

export const messageError = (
  error: ChatMessageFailure
):
  | StoreConflict
  | StoreReasonHttp[Exclude<ChatMessageError["reason"], typeof CHAT_MESSAGE_FAILURE.runner>]
  | HttpApiError.InternalServerError => {
  if (error instanceof ChatMessageConflictError) return new StoreConflict({})
  if (error.reason === CHAT_MESSAGE_FAILURE.runner) return new HttpApiError.InternalServerError({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

export const queueError = (
  error: ChatWriteFailure
):
  | StoreConflict
  | StoreReasonHttp[Exclude<ChatWriteError["reason"], typeof CHAT_WRITE_FAILURE.terminal>]
  | HttpApiError.InternalServerError => {
  if (error instanceof ChatWriteConflictError) return new StoreConflict({})
  if (error.reason === CHAT_WRITE_FAILURE.terminal) return new HttpApiError.InternalServerError({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

type ConnectionResultHttpError =
  | StoreConflict
  | StoreInvalid
  | HttpApiError.NotFound
  | HttpApiError.UnprocessableEntity
  | HttpApiError.ServiceUnavailable
  | HttpApiError.InternalServerError

export const connectionStoreError = (error: ToolExecutionStoreError): ConnectionResultHttpError => {
  if (error.reason === TOOL_STORE_FAILURE.blocked) return new StoreConflict({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

export const connectionCheckError = (error: ConnectionCheckError): ConnectionResultHttpError => {
  switch (error.reason) {
    case CONNECTION_CHECK_FAILURE.rejected:
      return new HttpApiError.UnprocessableEntity({})
    case CONNECTION_CHECK_FAILURE.unavailable:
      return new HttpApiError.ServiceUnavailable({})
    case CONNECTION_CHECK_FAILURE.storage:
      return new HttpApiError.InternalServerError({})
  }
}
