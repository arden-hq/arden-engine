import {
  CancelRequestSchema,
  CancelResponseSchema,
  ChatAcknowledgementSchema,
  ChatReceiptResponseSchema,
  ChatRequestSchema,
  ConnectionResultRequestSchema,
  ConnectionResumeResponseSchema,
  EnqueueChatMessageRequestSchema,
  HistoryQuerySchema,
  HistoryResponseSchema,
  QueuedCancelResponseSchema,
  QueuedChatMessageSchema,
  QueuedChatMessagesSchema,
  ReorderChatQueueRequestSchema,
  ToolCallQuerySchema,
  ToolCallResponseSchema,
  ToolResultValueQuerySchema,
  ToolResultValueResponseSchema,
  ToolResultRequestSchema,
  TurnDetailsQuerySchema,
  TurnDetailsResponseSchema,
  TurnWorkQuerySchema,
  TurnWorkResponseSchema
} from "@arden-hq/protocol/effect/chat"
import {
  HandCaptureRequestSchema,
  HandCaptureResponseSchema
} from "@arden-hq/protocol/effect/sessions"
import { Schema } from "effect"
import { CHAT_OPEN_TIMING_RESPONSE_HEADER } from "@arden-hq/protocol/chat-open-timing"
import * as Sse from "effect/unstable/encoding/Sse"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { OutputSchemaRejected, storeErrors } from "../errors.js"
import { ChatStreamError } from "../../chat/events.js"

export class ChatApi extends HttpApiGroup.make("chat", { topLevel: true }).add(
  HttpApiEndpoint.post("capture", "/captures", {
    payload: HandCaptureRequestSchema,
    success: HandCaptureResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("message", "/chat/message", {
    payload: ChatRequestSchema,
    success: ChatReceiptResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.ForbiddenNoContent,
      OutputSchemaRejected,
      ...storeErrors
    ]
  }),
  HttpApiEndpoint.post("cancel", "/cancel", {
    payload: CancelRequestSchema,
    success: CancelResponseSchema.pipe(HttpApiSchema.status(202)),
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("toolResult", "/tools/result", {
    payload: ToolResultRequestSchema,
    success: ChatAcknowledgementSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("connectionResult", "/connections/result", {
    payload: ConnectionResultRequestSchema,
    success: ChatAcknowledgementSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.ConflictNoContent,
      HttpApiError.UnprocessableEntityNoContent,
      ...storeErrors
    ]
  }),
  HttpApiEndpoint.post("connectionResume", "/connections/resume", {
    success: ConnectionResumeResponseSchema,
    error: [HttpApiError.UnprocessableEntityNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get("history", "/session/history", {
    query: HistoryQuerySchema,
    success: HistoryResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("turnWork", "/session/turn-work", {
    query: TurnWorkQuerySchema,
    success: TurnWorkResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("turnDetails", "/session/turn-details", {
    query: TurnDetailsQuerySchema,
    success: TurnDetailsResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("toolCall", "/session/tool-call", {
    query: ToolCallQuerySchema,
    success: ToolCallResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("toolResultValue", "/sessions/:sessionId/tool-results/:toolCallId", {
    params: { sessionId: Schema.NonEmptyString, toolCallId: Schema.NonEmptyString },
    query: ToolResultValueQuerySchema,
    success: ToolResultValueResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("events", "/chat/events/:sessionId", {
    params: { sessionId: Schema.NonEmptyString },
    success: HttpApiSchema.WithHeaders(
      HttpApiSchema.StreamSse({
        events: Sse.Event,
        error: ChatStreamError
      }),
      { [CHAT_OPEN_TIMING_RESPONSE_HEADER]: Schema.optional(Schema.String) }
    ),
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("listQueued", "/sessions/:sessionId/queue", {
    params: { sessionId: Schema.NonEmptyString },
    success: QueuedChatMessagesSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("enqueue", "/sessions/:sessionId/queue", {
    params: { sessionId: Schema.NonEmptyString },
    payload: EnqueueChatMessageRequestSchema,
    success: QueuedChatMessageSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.put("reorderQueued", "/sessions/:sessionId/queue", {
    params: { sessionId: Schema.NonEmptyString },
    payload: ReorderChatQueueRequestSchema,
    success: QueuedChatMessagesSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.delete("cancelQueued", "/sessions/:sessionId/queue/:clientId", {
    params: {
      sessionId: Schema.NonEmptyString,
      clientId: Schema.NonEmptyString
    },
    success: QueuedCancelResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  })
) {}
