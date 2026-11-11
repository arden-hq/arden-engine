import { Effect, Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  optionalNullableString,
  withExtras
} from "../common/schema.js"
import { ACTIVE_RUN_STATUSES } from "../runs/status.js"
import { SkillNameSchema } from "../skills/schema.js"
import { CHAT_QUEUE_LIMIT, CHAT_REPLY_QUOTES_MAX, chatReplyContexts } from "./contracts.js"
import type {
  ActiveRunSummary,
  CancelResponse,
  ChatAcknowledgement,
  ChatReceipt,
  PreparedChatMessage,
  QueuedCancelResponse,
  QueuedChatMessage,
  QueuedChatMessages,
  ReadResponse,
  RunsStatus
} from "./contracts.js"
import {
  ChatCaptureViaSchema,
  ChatImageSchema,
  ChatReceiptStatusSchema,
  ChatSentFromSchema,
  MarkSessionReadResponseSchema,
  TurnWorkViewSchema
} from "./schema.js"
import {
  chatIdentifier,
  chatMessage,
  ImageDataSchema,
  ImageMediaTypeSchema
} from "./schema-fields.js"
import { APPROVAL_MODES } from "../permissions/modes.js"

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

const ReplyContextInputSchema = Schema.Struct({
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
      ReplyContextInputSchema,
      Schema.NonEmptyArray(ReplyContextInputSchema).check(Schema.isMaxLength(CHAT_REPLY_QUOTES_MAX))
    ])
  ),
  recipe: Schema.optionalKey(SkillNameSchema),
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
  alternative: Schema.optionalKey(Schema.Literal("draft"))
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

export const HistoryRouteOptionsSchema = Schema.Struct({
  sessionId: Schema.optionalKey(chatIdentifier),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  before: Schema.optionalKey(chatIdentifier),
  after: Schema.optionalKey(chatIdentifier),
  around: Schema.optionalKey(chatIdentifier),
  aroundSeq: Schema.optionalKey(NonNegativeIntSchema)
}).check(
  Schema.makeFilter((query) => {
    const cursorCount = [query.before, query.after, query.around, query.aroundSeq].filter(
      (value) => value !== undefined
    ).length
    return cursorCount <= 1 ? undefined : "history accepts only one paging cursor"
  })
)

export const TurnWorkRouteOptionsSchema = Schema.Struct({
  sessionId: chatIdentifier,
  turnId: chatIdentifier,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  before: Schema.optionalKey(chatIdentifier),
  after: Schema.optionalKey(chatIdentifier),
  view: Schema.optionalKey(TurnWorkViewSchema)
}).check(
  Schema.makeFilter((options) =>
    options.before !== undefined && options.after !== undefined
      ? { path: ["after"], issue: "before and after are exclusive" }
      : undefined
  )
)

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

export const encodeReorderChatQueueRequestEffect = (value: unknown) =>
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

export const encodeChatMessageRequestEffect = (value: unknown) =>
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
          ...(input.recipe === undefined ? {} : { recipe: input.recipe }),
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

export const encodeEnqueueChatMessageRequestEffect = (value: unknown) =>
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

export const encodeToolResultRequestEffect = (value: unknown) =>
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
        ...(input.alternative === undefined ? {} : { alternative: input.alternative })
      })
    )
  )

export const encodeConnectionResultRequestEffect = (value: unknown) =>
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

export const encodeCancelRequestEffect = (value: unknown) =>
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

export const encodeHistoryPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(HistoryRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams()
      if (options.sessionId !== undefined) query.set("session_id", options.sessionId)
      if (options.limit !== undefined) query.set("limit", String(options.limit))
      if (options.before !== undefined) query.set("before", options.before)
      if (options.after !== undefined) query.set("after", options.after)
      if (options.around !== undefined) query.set("around", options.around)
      if (options.aroundSeq !== undefined) query.set("around_seq", String(options.aroundSeq))
      const suffix = query.toString()
      return suffix.length === 0 ? "/session/history" : `/session/history?${suffix}`
    })
  )

export const encodeTurnWorkPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(TurnWorkRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({
        session_id: options.sessionId,
        turn_id: options.turnId
      })
      if (options.limit !== undefined) query.set("limit", String(options.limit))
      if (options.before !== undefined) query.set("before", options.before)
      if (options.after !== undefined) query.set("after", options.after)
      if (options.view !== undefined) query.set("view", options.view)
      return `/session/turn-work?${query.toString()}`
    })
  )

export const encodeTurnDetailsPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(TurnDetailsRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({
        session_id: options.sessionId,
        turn_id: options.turnId
      })
      return `/session/turn-details?${query.toString()}`
    })
  )

export const encodeToolCallPathEffect = (value: unknown) =>
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

export const encodeToolResultValuePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ToolResultValueRouteOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({ path: options.path })
      return `/sessions/${encodeURIComponent(options.sessionId)}/tool-results/${encodeURIComponent(options.toolCallId)}?${query.toString()}`
    })
  )

export const encodeReadPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ReadPathInputSchema)(value, strict).pipe(
    Effect.map(({ sessionId }) => `/sessions/${encodeURIComponent(sessionId)}/read`)
  )

export const encodeEventPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(EventPathInputSchema)(value, strict).pipe(
    Effect.map(({ sessionId }) => `/chat/events/${encodeURIComponent(sessionId)}`)
  )

export const encodeQueuePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(QueuePathInputSchema)(value, strict).pipe(
    Effect.map(({ sessionId }) => `/sessions/${encodeURIComponent(sessionId)}/queue`)
  )

export const encodeQueuedMessagePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(QueuedMessagePathInputSchema)(value, strict).pipe(
    Effect.map(
      ({ clientId, sessionId }) =>
        `/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(clientId)}`
    )
  )

type ChatReceiptWire = Schema.Schema.Type<typeof ChatReceiptResponseSchema>
type CancelResponseWire = Schema.Schema.Type<typeof CancelResponseSchema>
type QueuedCancelResponseWire = Schema.Schema.Type<typeof QueuedCancelResponseSchema>
type ChatAcknowledgementWire = Schema.Schema.Type<typeof ChatAcknowledgementSchema>
type ReadResponseWire = Schema.Schema.Type<typeof MarkSessionReadResponseSchema>
type ActiveRunSummaryWire = Schema.Schema.Type<typeof ActiveRunSummarySchema>
type RunsStatusWire = Schema.Schema.Type<typeof RunsStatusSchema>

const mapActiveRunSummary = (run: ActiveRunSummaryWire): ActiveRunSummary => {
  const {
    run_id,
    turn_id,
    session_id,
    status,
    created_at,
    updated_at,
    age_seconds,
    idle_seconds,
    message_count,
    pending_injections,
    approvals_pending,
    runId: _runId,
    turnId: _turnId,
    sessionId: _sessionId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ageSeconds: _ageSeconds,
    idleSeconds: _idleSeconds,
    messageCount: _messageCount,
    pendingInjections: _pendingInjections,
    approvalsPending: _approvalsPending,
    ...extras
  } = run
  return {
    ...extras,
    runId: run_id,
    turnId: turn_id,
    sessionId: session_id,
    status,
    createdAt: created_at,
    updatedAt: updated_at,
    ageSeconds: age_seconds,
    idleSeconds: idle_seconds,
    messageCount: message_count,
    pendingInjections: pending_injections,
    approvalsPending: approvals_pending
  }
}

export const mapRunsStatus = (response: RunsStatusWire): RunsStatus => {
  const {
    observed_at,
    total_retained,
    active_runs,
    observedAt: _observedAt,
    totalRetained: _totalRetained,
    activeRuns: _activeRuns,
    ...extras
  } = response
  return {
    ...extras,
    observedAt: observed_at,
    totalRetained: total_retained,
    activeRuns: active_runs.map(mapActiveRunSummary)
  }
}

export const mapChatReceipt = (receipt: ChatReceiptWire): ChatReceipt => {
  const {
    run_id,
    session_id,
    status,
    client_id,
    runId: _runId,
    sessionId: _sessionId,
    clientId: _clientId,
    ...extras
  } = receipt
  return {
    ...extras,
    runId: run_id,
    sessionId: session_id,
    status,
    ...(client_id === undefined ? {} : { clientId: client_id })
  }
}

export const mapCancelResponse = (response: CancelResponseWire): CancelResponse => {
  const {
    run_id,
    cancel_requested,
    status,
    runId: _runId,
    cancelRequested: _cancelRequested,
    found: _found,
    ...extras
  } = response
  return { ...extras, status, runId: run_id, cancelRequested: cancel_requested }
}

export const mapQueuedCancelResponse = (
  response: QueuedCancelResponseWire
): QueuedCancelResponse => {
  const { client_id, status, clientId: _clientId, ...extras } = response
  return { ...extras, status, clientId: client_id }
}

export const mapChatAcknowledgement = (response: ChatAcknowledgementWire): ChatAcknowledgement => {
  const { status, ...extras } = response
  return { ...extras, status }
}

export const mapReadResponse = (response: ReadResponseWire): ReadResponse => {
  const {
    session_id,
    has_unread,
    sessionId: _sessionId,
    hasUnread: _hasUnread,
    ...extras
  } = response
  return {
    ...extras,
    sessionId: session_id,
    hasUnread: has_unread
  }
}
