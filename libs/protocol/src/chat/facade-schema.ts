import { Effect, Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  optionalNullableString,
  withExtras
} from "../common/schema.js"
import { ACTIVE_RUN_STATUSES } from "../runs/status.js"
import {
  CHAT_QUEUE_LIMIT,
  CHAT_REPLY_QUOTES_MAX,
  HISTORY_WINDOW,
  chatReplyContexts
} from "./contracts.js"
import type {
  HistoryWindow,
  PreparedChatMessage,
  QueuedChatMessage,
  QueuedChatMessages
} from "./contracts.js"
import {
  ChatCaptureViaSchema,
  ChatImageSchema,
  ChatReceiptStatusSchema,
  ChatSentFromSchema,
  TurnWorkViewSchema
} from "./schema.js"
import {
  chatIdentifier,
  chatMessage,
  ImageDataSchema,
  ImageMediaTypeSchema
} from "./schema-fields.js"
import { APPROVAL_MODES } from "../permissions/modes.js"

type EncodedText = Effect.Effect<string, Schema.SchemaError>

const strict = { onExcessProperty: "error" } as const
const chatResult = Schema.String.check(Schema.isMaxLength(100_000))
const optionalChatIdentifier = Schema.optionalKey(chatIdentifier)

export const ActiveRunStatusSchema = Schema.Literals(ACTIVE_RUN_STATUSES)

export const ActiveRunSummarySchema = withExtras({
  run_id: chatIdentifier,
  turn_id: chatIdentifier,
  session_id: chatIdentifier,
  status: ActiveRunStatusSchema,
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  age_seconds: NonNegativeIntSchema,
  idle_seconds: NonNegativeIntSchema,
  message_count: NonNegativeIntSchema,
  pending_injections: NonNegativeIntSchema,
  approvals_pending: NonNegativeIntSchema
})

export const RunsStatusSchema = withExtras({
  observed_at: IsoDateTimeStringSchema,
  total_retained: NonNegativeIntSchema,
  active_runs: Schema.Array(ActiveRunSummarySchema)
}).check(
  Schema.makeFilter((response) => {
    if (response.total_retained < response.active_runs.length) {
      return { path: ["total_retained"], issue: "cannot be smaller than active_runs length" }
    }
    return new Set(response.active_runs.map((run) => run.run_id)).size ===
      response.active_runs.length
      ? undefined
      : { path: ["active_runs"], issue: "contains duplicate run IDs" }
  })
)

export const ChatReplyContextSchema = Schema.Struct({
  messageId: chatIdentifier,
  role: Schema.Literals(["user", "assistant"] as const),
  content: chatMessage
})

export const ChatMessageInputSchema = Schema.Struct({
  sessionId: chatIdentifier,
  clientId: Schema.optionalKey(chatIdentifier),
  message: chatMessage,
  approvalReply: Schema.optionalKey(
    Schema.Struct({ runId: chatIdentifier, toolId: chatIdentifier })
  ),
  approvalMode: Schema.optionalKey(Schema.Literals(APPROVAL_MODES)),
  images: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        mediaType: ImageMediaTypeSchema,
        data: ImageDataSchema
      })
    )
  ),
  replyTo: Schema.optionalKey(
    Schema.Union([
      ChatReplyContextSchema,
      Schema.NonEmptyArray(ChatReplyContextSchema).check(Schema.isMaxLength(CHAT_REPLY_QUOTES_MAX))
    ])
  ),
  sentFrom: Schema.optionalKey(ChatSentFromSchema),
  capture: Schema.optionalKey(ChatCaptureViaSchema),
  outputSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
}).check(
  Schema.makeFilter((request) =>
    request.message.trim().length > 0 || (request.images?.length ?? 0) > 0
      ? undefined
      : { path: ["message"], issue: "message or images must contain content" }
  )
)

export const ToolResultInputSchema = Schema.Struct({
  runId: chatIdentifier,
  toolId: chatIdentifier,
  result: chatResult,
  approved: Schema.optionalKey(Schema.Boolean),
  grantStanding: Schema.optionalKey(Schema.Boolean),
  grantList: Schema.optionalKey(Schema.Literals(["space", "global"])),
  attachFolderToSpace: Schema.optionalKey(Schema.Boolean),
  editedArguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  alternative: Schema.optionalKey(Schema.Literal("draft")),
  askedAt: Schema.optionalKey(Schema.NonEmptyString),
  commandId: Schema.optionalKey(Schema.NonEmptyString)
}).check(
  Schema.makeFilter((input) =>
    input.grantList !== undefined && input.grantStanding !== true
      ? { path: ["grantList"], issue: "requires grantStanding to be true" }
      : undefined
  ),
  Schema.makeFilter((input) =>
    input.editedArguments !== undefined && input.approved !== true
      ? { path: ["editedArguments"], issue: "requires approved to be true" }
      : undefined
  ),
  Schema.makeFilter((input) =>
    input.alternative !== undefined && input.approved !== true
      ? { path: ["alternative"], issue: "requires approved to be true" }
      : undefined
  ),
  Schema.makeFilter((input) =>
    input.attachFolderToSpace === true && input.approved !== true
      ? { path: ["attachFolderToSpace"], issue: "requires approved to be true" }
      : undefined
  ),
  Schema.makeFilter((input) =>
    input.attachFolderToSpace === true && input.grantStanding === true
      ? { path: ["attachFolderToSpace"], issue: "cannot be combined with grantStanding" }
      : undefined
  )
)

export const ConnectionResultInputSchema = Schema.Struct({
  runId: chatIdentifier,
  toolId: chatIdentifier,
  connectionId: chatIdentifier,
  result: Schema.optionalKey(chatResult),
  approved: Schema.Boolean
})

export const CancelInputSchema = Schema.Struct({
  runId: optionalChatIdentifier,
  sessionId: optionalChatIdentifier,
  holdQueue: Schema.optionalKey(Schema.Boolean)
}).check(
  Schema.makeFilter((input) => {
    const hasRun = input.runId !== undefined
    const hasSession = input.sessionId !== undefined
    if (hasRun === hasSession) return "requires exactly one of runId or sessionId"
    return input.holdQueue === true && !hasSession ? "holdQueue needs a sessionId" : undefined
  })
)

const pageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))

const turnWorkWindowSchemas = [
  Schema.Struct({ kind: Schema.Literal(HISTORY_WINDOW.latest) }),
  Schema.Struct({ kind: Schema.Literal(HISTORY_WINDOW.before), cursor: chatIdentifier }),
  Schema.Struct({ kind: Schema.Literal(HISTORY_WINDOW.after), cursor: chatIdentifier })
] as const

export const HistoryRouteOptionsSchema = Schema.Struct({
  sessionId: chatIdentifier,
  limit: pageLimit,
  window: Schema.Union([
    ...turnWorkWindowSchemas,
    Schema.Struct({ kind: Schema.Literal(HISTORY_WINDOW.around), cursor: chatIdentifier }),
    Schema.Struct({ kind: Schema.Literal(HISTORY_WINDOW.aroundSeq), seq: NonNegativeIntSchema })
  ])
})

export const TurnWorkRouteOptionsSchema = Schema.Struct({
  sessionId: chatIdentifier,
  turnId: chatIdentifier,
  limit: pageLimit,
  window: Schema.Union(turnWorkWindowSchemas),
  view: TurnWorkViewSchema
})

const TurnDetailsRouteOptionsSchema = Schema.Struct({
  sessionId: chatIdentifier,
  turnId: chatIdentifier
})

export const ToolCallRouteOptionsSchema = Schema.Struct({
  sessionId: chatIdentifier,
  turnId: chatIdentifier,
  toolCallId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
})

const ReadPathInputSchema = Schema.Struct({
  sessionId: chatIdentifier
})

const EventPathInputSchema = Schema.Struct({
  sessionId: chatIdentifier
})

const QueuePathInputSchema = Schema.Struct({
  sessionId: chatIdentifier
})

const QueuedMessagePathInputSchema = Schema.Struct({
  clientId: chatIdentifier,
  sessionId: chatIdentifier
})

/** `POST /chat/message` receipt. A busy receipt has no run; every other status names one. */
export const ChatReceiptResponseSchema = withExtras({
  run_id: Schema.NullOr(Schema.NonEmptyString),
  session_id: chatIdentifier,
  status: ChatReceiptStatusSchema,
  delivery: Schema.optionalKey(Schema.Literals(["started", "steered"] as const)),
  client_id: optionalNullableString
}).check(
  Schema.makeFilter((receipt) =>
    (receipt.status === "busy") === (receipt.run_id === null)
      ? undefined
      : { path: ["run_id"], issue: "must be null exactly when status is busy" }
  )
)

export const ChatAcknowledgementSchema = withExtras({
  status: Schema.Literal("ok")
})

/** `POST /connections/resume`: the paused calls whose connection now checks out and that resumed. */
export const ConnectionResumeResponseSchema = withExtras({
  resumed: Schema.Array(
    withExtras({
      run_id: chatIdentifier,
      tool_id: chatIdentifier,
      connection_id: chatIdentifier
    })
  )
})

export const CancelResponseSchema = withExtras({
  status: Schema.Literal("cancelling"),
  run_id: chatIdentifier,
  cancel_requested: Schema.Boolean,
  found: Schema.Literal(true)
})

export const QueuedCancelResponseSchema = withExtras({
  status: Schema.Literal("cancelled"),
  client_id: chatIdentifier
})

const queuedMessageContent = Schema.makeFilter(
  (value: { readonly message: string; readonly images?: ReadonlyArray<unknown> }) =>
    value.message.trim().length > 0 || (value.images?.length ?? 0) > 0
      ? undefined
      : { path: ["message"], issue: "message or images must contain content" }
)

export const EnqueueChatMessageRequestSchema = withExtras({
  client_id: chatIdentifier,
  message: chatMessage,
  images: Schema.optionalKey(Schema.Array(ChatImageSchema)),
  sent_from: Schema.optionalKey(ChatSentFromSchema)
}).check(queuedMessageContent)

const QueueOrderSchema = Schema.Array(chatIdentifier).check(
  Schema.isMaxLength(CHAT_QUEUE_LIMIT),
  Schema.makeFilter((ids) =>
    new Set(ids).size === ids.length ? undefined : "contains duplicate client IDs"
  )
)

export const ReorderChatQueueRequestSchema = Schema.Struct({ client_ids: QueueOrderSchema })

export const encodeReorderChatQueueRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      sessionId: chatIdentifier,
      clientIds: QueueOrderSchema
    })
  )(value, strict).pipe(Effect.map((input) => JSON.stringify({ client_ids: input.clientIds })))

export const QueuedChatMessageSchema: Schema.Codec<QueuedChatMessage> = withExtras({
  client_id: chatIdentifier,
  message: chatMessage,
  images: Schema.Array(ChatImageSchema),
  enqueued_at: IsoDateTimeStringSchema,
  sent_from: Schema.optionalKey(ChatSentFromSchema),
  failed_reason: Schema.optionalKey(Schema.NonEmptyString)
})

export const QueuedChatMessagesSchema: Schema.Codec<QueuedChatMessages> = withExtras({
  session_id: chatIdentifier,
  messages: Schema.Array(QueuedChatMessageSchema).check(
    Schema.makeFilter((messages) =>
      new Set(messages.map((message) => message.client_id)).size === messages.length
        ? undefined
        : "contains duplicate client IDs"
    )
  )
})

export const EnqueueChatMessageInputSchema = Schema.Struct({
  sessionId: chatIdentifier,
  clientId: chatIdentifier,
  message: chatMessage,
  images: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        mediaType: ImageMediaTypeSchema,
        data: ImageDataSchema
      })
    )
  ),
  sentFrom: Schema.optionalKey(ChatSentFromSchema)
}).check(queuedMessageContent)

export const encodeChatMessageRequestEffect = (
  value: unknown
): Effect.Effect<PreparedChatMessage, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ChatMessageInputSchema)(value, strict).pipe(
    Effect.map((input): PreparedChatMessage => {
      const clientId = input.clientId ?? globalThis.crypto.randomUUID()
      return {
        clientId,
        body: JSON.stringify({
          message: input.message,
          session_id: input.sessionId,
          client_id: clientId,
          ...(input.approvalReply === undefined
            ? {}
            : {
                approval_reply: {
                  run_id: input.approvalReply.runId,
                  tool_id: input.approvalReply.toolId
                }
              }),
          ...(input.approvalMode === undefined ? {} : { approval_mode: input.approvalMode }),
          ...(input.sentFrom === undefined ? {} : { sent_from: input.sentFrom }),
          ...(input.capture === undefined ? {} : { capture: input.capture }),
          ...(input.outputSchema === undefined ? {} : { output_schema: input.outputSchema }),
          ...(input.replyTo === undefined
            ? {}
            : {
                reply_to: chatReplyContexts(input.replyTo).map((quoted) => ({
                  message_id: quoted.messageId,
                  role: quoted.role,
                  content: quoted.content
                }))
              }),
          ...(input.images === undefined
            ? {}
            : {
                images: input.images.map((image) => ({
                  type: "image" as const,
                  media_type: image.mediaType,
                  data: image.data
                }))
              })
        })
      }
    })
  )

export const encodeEnqueueChatMessageRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(EnqueueChatMessageInputSchema)(value, strict).pipe(
    Effect.map((input) =>
      JSON.stringify({
        client_id: input.clientId,
        message: input.message,
        ...(input.sentFrom === undefined ? {} : { sent_from: input.sentFrom }),
        ...(input.images === undefined
          ? {}
          : {
              images: input.images.map((image) => ({
                type: "image" as const,
                media_type: image.mediaType,
                data: image.data
              }))
            })
      })
    )
  )

export const encodeToolResultRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(ToolResultInputSchema)(value, strict).pipe(
    Effect.map((input) =>
      JSON.stringify({
        run_id: input.runId,
        tool_id: input.toolId,
        result: input.result,
        ...(input.approved === undefined ? {} : { approved: input.approved }),
        ...(input.grantStanding === undefined ? {} : { grant_standing: input.grantStanding }),
        ...(input.grantList === undefined ? {} : { grant_list: input.grantList }),
        ...(input.attachFolderToSpace === undefined
          ? {}
          : { attach_folder_to_space: input.attachFolderToSpace }),
        ...(input.editedArguments === undefined ? {} : { edited_arguments: input.editedArguments }),
        ...(input.alternative === undefined ? {} : { alternative: input.alternative }),
        ...(input.askedAt === undefined ? {} : { asked_at: input.askedAt }),
        ...(input.commandId === undefined ? {} : { command_id: input.commandId })
      })
    )
  )

export const encodeConnectionResultRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(ConnectionResultInputSchema)(value, strict).pipe(
    Effect.map((input) =>
      JSON.stringify({
        run_id: input.runId,
        tool_id: input.toolId,
        connection_id: input.connectionId,
        ...(input.result === undefined ? {} : { result: input.result }),
        approved: input.approved
      })
    )
  )

export const encodeCancelRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(CancelInputSchema)(value, strict).pipe(
    Effect.map((input) =>
      input.runId !== undefined
        ? JSON.stringify({ run_id: input.runId })
        : JSON.stringify({
            session_id: input.sessionId,
            ...(input.holdQueue === true ? { hold_queue: true } : {})
          })
    )
  )

const windowQuery = (query: URLSearchParams, window: HistoryWindow): void => {
  query.set("window", window.kind)
  if (window.kind === HISTORY_WINDOW.aroundSeq) query.set("seq", String(window.seq))
  else if (window.kind !== HISTORY_WINDOW.latest) query.set("cursor", window.cursor)
}

export const encodeHistoryPathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(HistoryRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({
        session_id: options.sessionId,
        limit: String(options.limit)
      })
      windowQuery(query, options.window)
      return `/session/history?${query.toString()}`
    })
  )

export const encodeTurnWorkPathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(TurnWorkRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({
        session_id: options.sessionId,
        turn_id: options.turnId,
        limit: String(options.limit),
        view: options.view
      })
      windowQuery(query, options.window)
      return `/session/turn-work?${query.toString()}`
    })
  )

export const encodeTurnDetailsPathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(TurnDetailsRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({
        session_id: options.sessionId,
        turn_id: options.turnId
      })
      return `/session/turn-details?${query.toString()}`
    })
  )

export const encodeToolCallPathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(ToolCallRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({
        session_id: options.sessionId,
        turn_id: options.turnId,
        tool_call_id: options.toolCallId
      })
      return `/session/tool-call?${query.toString()}`
    })
  )

const ToolResultValueRouteOptionsSchema = Schema.Struct({
  sessionId: chatIdentifier,
  toolCallId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  path: Schema.String.check(Schema.isMaxLength(500))
})

export const encodeToolResultValuePathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(ToolResultValueRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({ path: options.path })
      return `/sessions/${encodeURIComponent(options.sessionId)}/tool-results/${encodeURIComponent(options.toolCallId)}?${query.toString()}`
    })
  )

export const encodeReadPathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(ReadPathInputSchema)(value, strict).pipe(
    Effect.map(({ sessionId }) => `/sessions/${encodeURIComponent(sessionId)}/read`)
  )

export const encodeEventPathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(EventPathInputSchema)(value, strict).pipe(
    Effect.map(({ sessionId }) => `/chat/events/${encodeURIComponent(sessionId)}`)
  )

export const encodeQueuePathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(QueuePathInputSchema)(value, strict).pipe(
    Effect.map(({ sessionId }) => `/sessions/${encodeURIComponent(sessionId)}/queue`)
  )

export const encodeQueuedMessagePathEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(QueuedMessagePathInputSchema)(value, strict).pipe(
    Effect.map(
      ({ clientId, sessionId }) =>
        `/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(clientId)}`
    )
  )
