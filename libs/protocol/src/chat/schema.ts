import { Schema, SchemaTransformation } from "effect"
import { eventTypeLiterals } from "../common/event-types.js"
import type {
  ChatProjectionEvent,
  ChatServerEvent,
  FramedChatProjectionEvent,
  SnapshotProjectionEvent
} from "./events/stream.js"
import type { JsonRecord } from "../common/json.js"
import type { Agrees, Assert } from "../common/type-agreement.js"
import { ACTIVE_WORK } from "./history.js"
import { HistoryPageSchema, TurnShellSchema } from "./history-page-schema.js"
import type { HistoryResponse } from "./history.js"
import type { TurnDetailsResponse, TurnWorkResponse } from "./history.js"
import { CHAT_RECEIPT_STATUS, TOOL_CALL_RETURN } from "./contracts.js"
import type { ChatReceiptStatus, ToolCallResponse } from "./contracts.js"
import { event, isChatEventFrame, withExtras, NonNegativeIntSchema } from "../common/schema.js"

export * from "./events/run.js"
export * from "./events/text.js"
export * from "./events/reasoning.js"
export * from "./events/tool.js"
export * from "./events/approval.js"
export * from "./events/session.js"
export * from "./interaction.js"
export * from "./runtime-schema.js"
export * from "./history-query-schema.js"
export * from "./history-page-schema.js"
export * from "./history-tool-call.js"
export * from "./history-message-schema.js"
export * from "./request-schema.js"
import { ContextBudgetSnapshotSchema, HistoryMessageSchema } from "./history-message-schema.js"
import {
  ActiveRunSnapshotSchema,
  RuntimeApprovalSnapshotSchema,
  RuntimeConnectionSnapshotSchema
} from "./runtime-schema.js"
import { RUNTIME_RUN } from "./runtime.js"
import {
  runLifecycleEventSchemas,
  textStreamEventSchemas,
  reasoningStreamEventSchemas,
  toolCallEventSchemas,
  approvalEventSchemas,
  sessionStateEventSchemas
} from "./events/families.js"

export const StreamKeepaliveEventSchema = event("stream_keepalive", {
  session_id: Schema.NonEmptyString,
  seq: NonNegativeIntSchema,
  latest_seq: NonNegativeIntSchema
}).check(
  Schema.makeFilter((event) =>
    event.seq === event.latest_seq
      ? undefined
      : { path: ["latest_seq"], issue: "must equal the SSE sequence" }
  )
)

const chatProjectionEventSchemas = [
  ...runLifecycleEventSchemas,
  ...textStreamEventSchemas,
  ...reasoningStreamEventSchemas,
  ...toolCallEventSchemas,
  ...approvalEventSchemas,
  ...sessionStateEventSchemas
] as const

export const ChatProjectionEventSchema: Schema.Codec<ChatProjectionEvent> = Schema.Union(
  chatProjectionEventSchemas
)

export const FramedChatProjectionEventSchema = ChatProjectionEventSchema.pipe(
  Schema.refine((event): event is FramedChatProjectionEvent => isChatEventFrame(event), {
    message: "chat events must carry session_id, seq, timestamp and replay"
  })
)

export const CHAT_PROJECTION_EVENT_TYPES: ReadonlySet<string> = eventTypeLiterals(
  chatProjectionEventSchemas
)

const isKnownProjectionEventCandidate = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string" &&
  CHAT_PROJECTION_EVENT_TYPES.has(value.type)

export type ChatProjectionEventAgrees = Assert<
  Agrees<(typeof chatProjectionEventSchemas)[number]["Type"], ChatProjectionEvent>
>

export const ChatReceiptStatusSchema = Schema.Literals(Object.values(CHAT_RECEIPT_STATUS))

export const SessionRuntimeSnapshotSchema = withExtras({
  session_id: Schema.String,
  latest_event_seq: Schema.Int,
  checkpoint_seq: Schema.Int,
  active_run: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUNTIME_RUN.idle) }),
    Schema.Struct({ kind: Schema.Literal(RUNTIME_RUN.active), run: ActiveRunSnapshotSchema })
  ]),
  blocking_work: Schema.Boolean,
  pending_approvals: Schema.Array(RuntimeApprovalSnapshotSchema),
  pending_connections: Schema.Array(RuntimeConnectionSnapshotSchema)
})

export const TurnDetailsQuerySchema = withExtras({
  session_id: Schema.NonEmptyString,
  turn_id: Schema.NonEmptyString
})

export const ToolCallQuerySchema = withExtras({
  session_id: Schema.NonEmptyString,
  turn_id: Schema.NonEmptyString,
  tool_call_id: Schema.NonEmptyString
})

export const ToolCallResponseSchema: Schema.Codec<ToolCallResponse> = withExtras({
  tool_call_id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  arguments: Schema.String,
  result: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(TOOL_CALL_RETURN.pending) }),
    Schema.Struct({ kind: Schema.Literal(TOOL_CALL_RETURN.returned), text: Schema.String })
  ]),
  is_error: Schema.Boolean
})

export const ToolResultValueQuerySchema = Schema.Struct({
  path: Schema.String
})

export const TOOL_RESULT_VALUE = { value: "value", unavailable: "unavailable" } as const

export const TOOL_RESULT_VALUE_GAP = {
  noCall: "no_call",
  notJson: "not_json",
  noPath: "no_path",
  tooLarge: "too_large"
} as const

export const ToolResultValueResponseSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal(TOOL_RESULT_VALUE.value), value: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal(TOOL_RESULT_VALUE.unavailable),
    reason: Schema.Literals(Object.values(TOOL_RESULT_VALUE_GAP))
  })
])

export type ToolResultValueResponse = typeof ToolResultValueResponseSchema.Type

export const MarkSessionReadResponseSchema = withExtras({
  session_id: Schema.NonEmptyString,
  has_unread: Schema.Boolean
})

export const TurnWorkResponseSchema: Schema.Codec<TurnWorkResponse> = withExtras({
  turn_id: Schema.NonEmptyString,
  messages: Schema.Array(HistoryMessageSchema),
  page: HistoryPageSchema
})

export const TurnDetailsResponseSchema: Schema.Codec<TurnDetailsResponse> = withExtras({
  turn_id: Schema.NonEmptyString,
  messages: Schema.Array(HistoryMessageSchema),
  complete: Schema.Boolean
})

export const HistoryResponseSchema: Schema.Codec<HistoryResponse> = withExtras({
  messages: Schema.Array(HistoryMessageSchema),
  active_work_tail: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(ACTIVE_WORK.idle) }),
    Schema.Struct({ kind: Schema.Literal(ACTIVE_WORK.running), work: TurnWorkResponseSchema })
  ]),
  runtime: SessionRuntimeSnapshotSchema,
  page: HistoryPageSchema,
  context_budget: ContextBudgetSnapshotSchema,
  turn_shells: Schema.Array(TurnShellSchema)
})

export const SnapshotProjectionEventSchema = ChatProjectionEventSchema.pipe(
  Schema.refine(
    (event): event is SnapshotProjectionEvent => isChatEventFrame(event) && event.replay === true,
    { message: "snapshot events must carry session_id, seq, timestamp and replay" }
  )
)

const knownSnapshotProjectionEventsSchema = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.Unknown.pipe(Schema.decodeTo(SnapshotProjectionEventSchema))),
    SchemaTransformation.transform<ReadonlyArray<unknown>, ReadonlyArray<unknown>>({
      decode: (items) => items.filter(isKnownProjectionEventCandidate),
      encode: (items) => items
    })
  )
)

export const SessionResumeSnapshotSchema = withExtras({
  version: Schema.Literal(1),
  applied_seq: NonNegativeIntSchema,
  history: HistoryResponseSchema,
  active_events: knownSnapshotProjectionEventsSchema
}).check(
  Schema.makeFilter((snapshot) => {
    const issues: Array<Schema.FilterIssue> = []
    const runtime = snapshot.history.runtime
    if (
      runtime.latest_event_seq !== snapshot.applied_seq ||
      runtime.checkpoint_seq < 0 ||
      runtime.checkpoint_seq > snapshot.applied_seq
    ) {
      issues.push({
        path: ["history", "runtime"],
        issue: "history cursor must cover the snapshot exactly"
      })
    }
    let previousSequence = runtime.checkpoint_seq
    for (const [index, event] of snapshot.active_events.entries()) {
      if (
        event.session_id !== runtime.session_id ||
        !Number.isSafeInteger(event.seq) ||
        event.seq <= previousSequence ||
        event.seq > snapshot.applied_seq
      ) {
        issues.push({
          path: ["active_events", index],
          issue: "snapshot events must be ordered, replay-marked, and covered by applied_seq"
        })
      }
      previousSequence = event.seq
    }
    return issues
  })
)

export const StreamSnapshotEventSchema = withExtras({
  type: Schema.Literal("stream_snapshot"),
  session_id: Schema.NonEmptyString,
  seq: NonNegativeIntSchema,
  snapshot: SessionResumeSnapshotSchema
}).check(
  Schema.makeFilter((event) =>
    event.seq === event.snapshot.applied_seq &&
    event.session_id === event.snapshot.history.runtime.session_id
      ? undefined
      : "snapshot identity and applied sequence must match the frame"
  )
)

export const StreamLiveEventSchema = withExtras({
  type: Schema.Literal("stream_live"),
  session_id: Schema.NonEmptyString,
  seq: NonNegativeIntSchema,
  caught_up_through: NonNegativeIntSchema
}).check(
  Schema.makeFilter((event) =>
    event.seq === event.caught_up_through
      ? undefined
      : { path: ["caught_up_through"], issue: "must equal the SSE sequence" }
  )
)

export const StreamOverflowEventSchema = withExtras({
  type: Schema.Literal("stream_overflow"),
  session_id: Schema.NonEmptyString,
  seq: NonNegativeIntSchema,
  cursor: NonNegativeIntSchema,
  reason: Schema.Literals(["follower_buffer", "active_projection"] as const)
}).check(
  Schema.makeFilter((event) =>
    event.seq === event.cursor
      ? undefined
      : { path: ["cursor"], issue: "must equal the SSE sequence" }
  )
)

const chatServerEventSchemas = [
  FramedChatProjectionEventSchema,
  StreamKeepaliveEventSchema,
  StreamSnapshotEventSchema,
  StreamLiveEventSchema,
  StreamOverflowEventSchema
] as const

export const ChatServerEventSchema: Schema.Codec<ChatServerEvent, JsonRecord> =
  Schema.Union(chatServerEventSchemas)

export type ChatServerEventAgrees = Assert<
  Agrees<(typeof chatServerEventSchemas)[number]["Type"], ChatServerEvent>
>

export type ChatReceiptStatusAgrees = Assert<
  Agrees<(typeof ChatReceiptStatusSchema)["Type"], ChatReceiptStatus>
>

export { QuestionAnswerSchema } from "./schema-fields.js"
export { chatIdentifier as ChatIdentifierSchema } from "./schema-fields.js"
