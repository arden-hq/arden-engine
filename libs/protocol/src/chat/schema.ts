import { RunApprovalWorkSchema } from "../runs/context.js"
import { RuleSavedInSchema } from "../runs/questions.js"
import { Schema, SchemaTransformation } from "effect"
import { eventTypeLiterals } from "../common/event-types.js"
import type {
  ChatProjectionEvent,
  ChatServerEvent,
  SnapshotProjectionEvent
} from "./events/stream.js"
import type { JsonRecord } from "../common/json.js"
import type { Agrees, Assert } from "../common/type-agreement.js"
import type { HistoryMessage } from "./history.js"
import type { HistoryResponse } from "./history.js"
import type { TurnDetailsResponse, TurnWorkResponse } from "./history.js"
import type { ChatReceiptStatus, ToolCallResponse } from "./contracts.js"
import {
  ConnectionActionSchema,
  ConnectionStateSchema,
  ToolOutcomeSchema,
  event,
  optionalBoolean,
  optionalInt,
  optionalNullableString,
  optionalNumber,
  optionalString,
  optionalUnknown,
  withExtras,
  NonNegativeIntSchema
} from "../common/schema.js"
import { ApprovalPresentationSchema } from "./approval-presentation.js"
import { ChatUpdateSchema, CommunicationEnvelopeSchema } from "./communication-schema.js"
import { GmailSendReceiptSchema } from "./gmail-receipt.js"
import {
  QuestionAnswerSchema,
  chatIdentifier,
  chatMessage,
  ImageDataSchema,
  ImageMediaTypeSchema,
  ServedImageDataSchema
} from "./schema-fields.js"

export * from "./events/run.js"
export * from "./events/text.js"
export * from "./events/reasoning.js"
export * from "./events/tool.js"
export * from "./events/approval.js"
export * from "./events/session.js"
export * from "./interaction.js"
import { AgentResultSchema, InteractionSchema } from "./interaction.js"
import { SkillNameSchema } from "../skills/schema.js"
import {
  runLifecycleEventSchemas,
  textStreamEventSchemas,
  reasoningStreamEventSchemas,
  toolCallEventSchemas,
  approvalEventSchemas,
  sessionStateEventSchemas
} from "./events/families.js"
import { APPROVAL_MODES } from "../permissions/modes.js"

export const StreamKeepaliveEventSchema = event("stream_keepalive", {
  latest_seq: NonNegativeIntSchema
}).check(
  Schema.makeFilter((event) =>
    event.seq === undefined || event.seq === event.latest_seq
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

/**
 * Annotated with the hand-written event union on purpose. Without the
 * annotation every consumer re-expands forty struct schemas (and their extras
 * mapped types) each time it relates a value to this schema; the HttpApi
 * handler for run events then exceeds the compiler's instantiation depth
 * (TS2589) as soon as one more member is added. The named union is the same
 * type, related by name, and costs nothing to add members to.
 */
export const ChatProjectionEventSchema: Schema.Codec<ChatProjectionEvent> = Schema.Union(
  chatProjectionEventSchemas
)

/** Every `type` the projection stream can carry, read from the schemas. */
export const CHAT_PROJECTION_EVENT_TYPES: ReadonlySet<string> = eventTypeLiterals(
  chatProjectionEventSchemas
)

const isKnownProjectionEventCandidate = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string" &&
  CHAT_PROJECTION_EVENT_TYPES.has(value.type)

/** @internal Compile-time check that the schema and the type agree. */
export type ChatProjectionEventAgrees = Assert<
  Agrees<(typeof chatProjectionEventSchemas)[number]["Type"], ChatProjectionEvent>
>

export const ContextBlockSchema = withExtras({
  type: Schema.optionalKey(Schema.Literal("context")),
  content_type: Schema.String,
  content: optionalNullableString,
  metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))
})

/** The chat a handed-over message came from (`HistoryMessage.from_chat`). */
export const ChatHandoffSourceSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  session_ref: Schema.NonEmptyString
})

export const ChatForwardedSourceSchema = Schema.Struct({
  ...ChatHandoffSourceSchema.fields,
  message_id: Schema.NonEmptyString
})

/** `ChatSentFrom`: the UI surface that wrote a confirmed message's words, or the command line. */
export const ChatSentFromSchema = Schema.Literals(["visualization", "answer", "cli"] as const)

/** `ConnectionArrival`: a connection card answered, as the transcript row records it. */
export const ConnectionArrivalSchema = Schema.Struct({
  tool_call_id: Schema.NonEmptyString,
  server: Schema.NonEmptyString,
  outcome: Schema.Literals(["connected", "declined"] as const),
  offered_at: Schema.NonEmptyString,
  at: Schema.NonEmptyString
})

/** `ChatCaptureVia`: a message sent as a capture, from the quick-capture window or iPhone. */
export const ChatCaptureViaSchema = Schema.Literals(["quick", "phone"] as const)

const ReplyContextSchema = Schema.Struct({
  message_id: chatIdentifier,
  role: Schema.Literals(["user", "assistant"] as const),
  content: chatMessage
})

export const ChatImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  media_type: ImageMediaTypeSchema,
  data: ImageDataSchema
})

const HistoryImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  media_type: ImageMediaTypeSchema,
  data: ServedImageDataSchema
})

export const ChatRequestSchema = withExtras({
  approval_reply: Schema.optionalKey(
    Schema.Struct({ run_id: Schema.NonEmptyString, tool_id: Schema.NonEmptyString })
  ),
  message: Schema.String,
  session_id: Schema.NonEmptyString,
  client_id: optionalNullableString,
  approval_mode: Schema.optionalKey(Schema.Literals(APPROVAL_MODES)),
  images: Schema.optionalKey(Schema.Array(ChatImageSchema)),
  reply_to: Schema.optionalKey(ReplyContextSchema),
  /** The Recipe the user started this message from, by its Skill name. */
  recipe: Schema.optionalKey(SkillNameSchema),
  /** The UI surface that wrote this message's words; the person only confirmed it. */
  sent_from: Schema.optionalKey(ChatSentFromSchema),
  /** Sent as a capture (quick-capture window or iPhone): raises `capture.arrived`. */
  capture: Schema.optionalKey(ChatCaptureViaSchema),
  /** A JSON Schema the Run's final answer must match. */
  output_schema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
}).check(
  Schema.makeFilter((request) =>
    request.message.trim().length > 0 || (request.images?.length ?? 0) > 0
      ? undefined
      : { path: ["message"], issue: "message or images must contain content" }
  )
)

export const ToolResultRequestSchema = withExtras({
  run_id: Schema.String,
  tool_id: Schema.String,
  result: Schema.String,
  approved: optionalBoolean,
  grant_standing: optionalBoolean,
  /** Where "Always allow" saves: "space" (This Space) or "global" (Everywhere). */
  grant_list: Schema.optionalKey(Schema.Literals(["space", "global"])),
  attach_folder_to_space: optionalBoolean,
  /** The card's editable fields as the person left them; a field absent was cleared. */
  edited_arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  /** The card's alternative to the call as asked: `draft` saves instead of sending. */
  alternative: Schema.optionalKey(Schema.Literal("draft"))
}).check(
  Schema.makeFilter((request) =>
    request.edited_arguments !== undefined && request.approved !== true
      ? { path: ["edited_arguments"], issue: "requires approved to be true" }
      : undefined
  ),
  Schema.makeFilter((request) =>
    request.alternative !== undefined && request.approved !== true
      ? { path: ["alternative"], issue: "requires approved to be true" }
      : undefined
  ),
  Schema.makeFilter((request) =>
    request.attach_folder_to_space === true && request.approved !== true
      ? { path: ["attach_folder_to_space"], issue: "requires approved to be true" }
      : undefined
  ),
  Schema.makeFilter((request) =>
    request.grant_list !== undefined && request.grant_standing !== true
      ? { path: ["grant_list"], issue: "requires grant_standing to be true" }
      : undefined
  ),
  Schema.makeFilter((request) =>
    request.attach_folder_to_space === true && request.grant_standing === true
      ? { path: ["attach_folder_to_space"], issue: "cannot be combined with grant_standing" }
      : undefined
  )
)

export const ConnectionResultRequestSchema = withExtras({
  run_id: Schema.String,
  tool_id: Schema.String,
  connection_id: Schema.String,
  result: optionalString,
  approved: Schema.Boolean
})

export const CancelRequestSchema = withExtras({
  run_id: optionalNullableString,
  session_id: optionalNullableString,
  hold_queue: optionalBoolean
}).check(
  Schema.makeFilter((input) => {
    const hasRun = input.run_id !== undefined && input.run_id !== null && input.run_id.length > 0
    const hasSession =
      input.session_id !== undefined && input.session_id !== null && input.session_id.length > 0
    if (hasRun === hasSession) return "requires exactly one of run_id or session_id"
    return input.hold_queue === true && !hasSession ? "hold_queue needs a session_id" : undefined
  })
)

export const ChatReceiptStatusSchema = Schema.Literals([
  "running",
  "queued",
  "ingested",
  "accepted",
  "cancelled",
  "busy",
  "steered",
  "active",
  "resumed",
  "completed",
  "error",
  "failed",
  "interrupted"
] as const)

export const RuntimeApprovalSnapshotSchema = withExtras({
  tool_id: Schema.String,
  source: Schema.optionalKey(Schema.Literals(["run", "deferred"] as const)),
  tool_name: Schema.String,
  preview: optionalNullableString,
  diff: optionalNullableString,
  status: Schema.Literal("pending"),
  requested_at: optionalNullableString,
  run_id: optionalNullableString,
  session_id: optionalNullableString,
  action: optionalNullableString,
  scope: optionalNullableString,
  expires_at: optionalNullableString,
  description: optionalNullableString,
  rule_places: Schema.optionalKey(Schema.Array(RuleSavedInSchema)),
  can_attach_folder_to_space: optionalBoolean,
  grant_folder: Schema.optionalKey(Schema.String),
  parent_session_id: optionalNullableString,
  presentation: Schema.optionalKey(Schema.NullOr(ApprovalPresentationSchema)),
  work: Schema.optionalKey(RunApprovalWorkSchema)
})

export const RuntimeConnectionSnapshotSchema = withExtras({
  tool_id: Schema.String,
  run_id: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  integration_id: Schema.String,
  connection_id: Schema.String,
  label: Schema.String,
  reason: ConnectionStateSchema,
  detail: Schema.String,
  capability: Schema.String,
  action: ConnectionActionSchema,
  settings_tab: Schema.String,
  required_scopes: Schema.Array(Schema.String),
  source: Schema.Literals(["recovery", "suggestion"] as const),
  decision_delivery: Schema.optionalKey(Schema.Literals(["blocking", "deferred"] as const)),
  account_ref: optionalNullableString
})

export const ActiveRunSnapshotSchema = withExtras({
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString,
  status: Schema.String,
  started_at: optionalNullableString,
  updated_at: optionalNullableString,
  ended_at: optionalNullableString,
  stop_reason: optionalNullableString,
  checkpoint_seq: Schema.Int,
  latest_event_seq: Schema.Int,
  error_code: optionalNullableString,
  error_message: optionalNullableString,
  pending_approvals: Schema.Array(RuntimeApprovalSnapshotSchema),
  pending_connections: Schema.Array(RuntimeConnectionSnapshotSchema),
  waiting_tool_call_ids: Schema.optionalKey(Schema.Array(Schema.String))
})

export const SessionRuntimeSnapshotSchema = withExtras({
  session_id: Schema.NullOr(Schema.String),
  latest_event_seq: Schema.Int,
  checkpoint_seq: Schema.Int,
  active_run: Schema.NullOr(ActiveRunSnapshotSchema),
  blocking_work: Schema.Boolean,
  pending_approvals: Schema.Array(RuntimeApprovalSnapshotSchema),
  pending_connections: Schema.Array(RuntimeConnectionSnapshotSchema)
})

const historyLimitSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 100 })
)
const nonNegativeIntegerFromString = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)

export const HistoryQuerySchema = withExtras({
  session_id: Schema.optionalKey(Schema.NonEmptyString),
  limit: Schema.optionalKey(historyLimitSchema),
  before: Schema.optionalKey(Schema.NonEmptyString),
  after: Schema.optionalKey(Schema.NonEmptyString),
  around: Schema.optionalKey(Schema.NonEmptyString),
  around_seq: Schema.optionalKey(nonNegativeIntegerFromString)
}).check(
  Schema.makeFilter((query) => {
    const cursors = [query.before, query.after, query.around, query.around_seq].filter(
      (value) => value !== undefined
    )
    return cursors.length <= 1
      ? undefined
      : { path: [], issue: "history accepts only one paging cursor" }
  })
)

export const TurnWorkViewSchema = Schema.Literals(["full", "compact"] as const)

export const TurnWorkQuerySchema = withExtras({
  session_id: Schema.NonEmptyString,
  turn_id: Schema.NonEmptyString,
  limit: Schema.optionalKey(historyLimitSchema),
  before: Schema.optionalKey(Schema.NonEmptyString),
  after: Schema.optionalKey(Schema.NonEmptyString),
  /** `compact` rows carry what a trail row shows; arguments and output past
   *  a short prefix are fetched on demand through the tool-call route. */
  view: Schema.optionalKey(TurnWorkViewSchema)
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

/** One call in full: the arguments the model sent and the result it got. */
export const ToolCallResponseSchema: Schema.Codec<ToolCallResponse> = withExtras({
  tool_call_id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  arguments: Schema.String,
  result: Schema.NullOr(Schema.String),
  is_error: optionalBoolean
})

export const ToolResultValueQuerySchema = Schema.Struct({
  /** Dot path into the result's JSON; empty or absent reads the whole result. */
  path: Schema.optionalKey(Schema.String)
})

/** One value from a tool call's result in one chat, for an answer block's
 *  `Query("tool_result", …)`: the value, or why there is none. */
export const ToolResultValueResponseSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("value"), value: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["no_call", "not_json", "no_path", "too_large"])
  })
])

export type ToolResultValueResponse = typeof ToolResultValueResponseSchema.Type

export const MarkSessionReadResponseSchema = withExtras({
  session_id: Schema.NonEmptyString,
  has_unread: Schema.Boolean
})

const historyToolCallSchema = withExtras({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  execution: Schema.optionalKey(Schema.Literals(["runtime", "provider"] as const)),
  started_at: optionalNumber,
  parent_id: optionalNullableString,
  display_name: optionalString,
  display_title: optionalString,
  result: optionalString,
  kind: optionalString,
  icon: optionalNullableString,
  noun: optionalNullableString,
  source: optionalNullableString,
  presentation: Schema.optionalKey(Schema.Literals(["work", "conversation", "status"] as const)),
  is_error: optionalBoolean,
  retryable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  outcome: Schema.optionalKey(ToolOutcomeSchema),
  gmail_send_receipt: Schema.optionalKey(GmailSendReceiptSchema),
  /** The result's structured data for a conversation-surface call, so the
   *  conversation stream can render a proposal or a navigation card without
   *  the work trail's tool row; on a provider call, the places it read
   *  (`source_refs`), since it has no tool row. */
  data: optionalUnknown,
  /** Wall-clock run time of the call from the tool execution ledger, so a
   *  reopened chat shows the same duration the live row did. */
  duration_ms: optionalNumber
})

const historyAssistantOutputPartSchema = Schema.Union([
  withExtras({
    type: Schema.Literal("reasoning"),
    text: Schema.NonEmptyString,
    source_index: NonNegativeIntSchema
  }),
  withExtras({
    type: Schema.Literal("text"),
    text: Schema.NonEmptyString,
    phase: Schema.optionalKey(Schema.Literals(["commentary", "final_answer"] as const)),
    source_index: NonNegativeIntSchema
  }),
  withExtras({
    type: Schema.Literal("tool_call"),
    tool_call_id: Schema.NonEmptyString,
    execution: Schema.Literals(["runtime", "provider"] as const),
    source_index: NonNegativeIntSchema
  })
])

const historyMessageFields = {
  communication: Schema.optionalKey(CommunicationEnvelopeSchema),
  update: Schema.optionalKey(ChatUpdateSchema),
  agent_result: Schema.optionalKey(AgentResultSchema),
  interaction: Schema.optionalKey(InteractionSchema),
  content: Schema.String,
  context: Schema.optionalKey(Schema.Array(ContextBlockSchema)),
  reasoning_content: optionalString,
  tool_calls: Schema.optionalKey(Schema.Array(historyToolCallSchema)),
  output_parts: Schema.optionalKey(Schema.Array(historyAssistantOutputPartSchema)),
  tool_call_id: optionalString,
  data: optionalUnknown,
  /** Set on a compact-view row: long arguments and output were cut to a
   *  prefix; the tool-call route has the rest. */
  compact: optionalBoolean,
  message_id: Schema.String,
  client_id: optionalString,
  seq: optionalInt,
  created_at: optionalString,
  /** A steer's stamp: when the running turn took it in, as opposed to when it
   *  was sent. Absent on rows that started their turn and on older rows. */
  applied_at: optionalString,
  is_meta: optionalBoolean,
  reply_to: Schema.optionalKey(ReplyContextSchema),
  recipe: Schema.optionalKey(SkillNameSchema),
  /** On the hidden row that carries a Run question's answer to the run: which
   *  question. A mid-run answer is where the question's card sits. */
  question_answer: Schema.optionalKey(QuestionAnswerSchema),
  /** On the hidden row that tells the agent a connection card was answered. */
  connection: Schema.optionalKey(ConnectionArrivalSchema),
  /** On a message Arden handed over from another chat: that chat. */
  from_chat: Schema.optionalKey(ChatHandoffSourceSchema),
  forwarded_from: Schema.optionalKey(ChatForwardedSourceSchema),
  /** On a message whose words a UI surface wrote and the person confirmed. */
  sent_from: Schema.optionalKey(ChatSentFromSchema),
  turn_id: Schema.NonEmptyString,
  automation: Schema.optionalKey(
    Schema.Struct({
      task_id: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
      prompt: Schema.NonEmptyString,
      context_mode: Schema.Literals(["fresh", "continue", "fork"] as const)
    })
  )
} as const

const noImages = Schema.makeFilter((message: Readonly<Record<string, unknown>>) =>
  "images" in message
    ? { path: ["images"], issue: "images are valid only on user messages" }
    : undefined
)

/**
 * One struct per role, so the wire shape and the hand-written `HistoryMessage`
 * union agree by construction: images exist only on user rows, tool outcome
 * fields only on tool rows.
 */
export const HistoryMessageSchema: Schema.Codec<HistoryMessage> = Schema.Union([
  withExtras({
    ...historyMessageFields,
    role: Schema.Literal("user"),
    images: Schema.optionalKey(Schema.Array(HistoryImageSchema))
  }),
  withExtras({
    ...historyMessageFields,
    role: Schema.Literal("assistant")
  }).check(noImages),
  withExtras({
    ...historyMessageFields,
    role: Schema.Literal("tool"),
    is_error: optionalBoolean,
    retryable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    outcome: Schema.optionalKey(ToolOutcomeSchema)
  }).check(noImages)
])

export const HistoryPageSchema = withExtras({
  has_more_before: Schema.Boolean,
  has_more_after: Schema.Boolean,
  before: optionalNullableString,
  after: optionalNullableString
})

export const ContextBudgetSnapshotSchema = withExtras({
  model: Schema.NullOr(Schema.String),
  hard_limit: Schema.NullOr(Schema.Int),
  compaction_trigger: Schema.NullOr(Schema.Int),
  input_tokens: Schema.Int,
  message_count: Schema.Int
})

/** A turn record without its messages: enough to group a paged window whose
 *  head starts mid-turn (the enclosing turn's identity and stamps). */
export const TurnShellSchema = withExtras({
  turn_id: Schema.NonEmptyString,
  message_start_seq: NonNegativeIntSchema,
  message_end_seq: NonNegativeIntSchema,
  started_at: Schema.String,
  ended_at: Schema.String,
  has_work: Schema.Boolean,
  has_tool_work: Schema.Boolean,
  tool_calls: Schema.optionalKey(
    Schema.Array(
      withExtras({
        name: Schema.String,
        display_name: Schema.NullOr(Schema.String),
        count: NonNegativeIntSchema,
        rejected: Schema.optionalKey(NonNegativeIntSchema)
      })
    )
  ),
  error_code: Schema.optionalKey(Schema.String),
  error_message: Schema.optionalKey(Schema.String)
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
  active_work_tail: Schema.NullOr(TurnWorkResponseSchema),
  runtime: SessionRuntimeSnapshotSchema,
  page: HistoryPageSchema,
  context_budget: ContextBudgetSnapshotSchema,
  /** Turn records covering every turn_id in `messages`, in turn order. */
  turn_shells: Schema.optionalKey(Schema.Array(TurnShellSchema))
})

/** A projection event as a resume snapshot carries it: addressed, sequenced, replay-marked. */
export const SnapshotProjectionEventSchema = ChatProjectionEventSchema.pipe(
  Schema.refine(
    (event): event is SnapshotProjectionEvent =>
      typeof event.session_id === "string" &&
      typeof event.seq === "number" &&
      event.replay === true,
    { message: "snapshot events must carry session_id, seq and replay" }
  )
)

/**
 * A snapshot's replayed events, with events of a type this client does not
 * know dropped before decoding. A newer server may journal an event an older
 * client has never seen; that must cost the client one event, not the whole
 * resume. A known type with a bad payload is still a decode error.
 */
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
        event.replay !== true ||
        event.seq === undefined ||
        !Number.isSafeInteger(event.seq) ||
        event.seq <= previousSequence ||
        event.seq > snapshot.applied_seq
      ) {
        issues.push({
          path: ["active_events", index],
          issue: "snapshot events must be ordered, replay-marked, and covered by applied_seq"
        })
      }
      if (event.seq !== undefined) previousSequence = event.seq
    }
    return issues
  })
)

export const StreamSnapshotEventSchema = withExtras({
  type: Schema.Literal("stream_snapshot"),
  timestamp: optionalNumber,
  replay: optionalBoolean,
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
  timestamp: optionalNumber,
  replay: optionalBoolean,
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
  timestamp: optionalNumber,
  replay: optionalBoolean,
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
  ChatProjectionEventSchema,
  StreamKeepaliveEventSchema,
  StreamSnapshotEventSchema,
  StreamLiveEventSchema,
  StreamOverflowEventSchema
] as const

// Encoded is the JSON object on the wire: the snapshot member decodes its
// replayed events through a refinement, so its encoded shape is wider than its type.
export const ChatServerEventSchema: Schema.Codec<ChatServerEvent, JsonRecord> =
  Schema.Union(chatServerEventSchemas)

/** @internal Compile-time check that the schema and the type agree. */
export type ChatServerEventAgrees = Assert<
  Agrees<(typeof chatServerEventSchemas)[number]["Type"], ChatServerEvent>
>

export const decodeChatRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ChatRequestSchema)(value)

export const decodeToolResultRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ToolResultRequestSchema)(value)

export const decodeConnectionResultRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ConnectionResultRequestSchema)(value)

export const decodeCancelRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CancelRequestSchema)(value)

export const decodeHistoryQueryEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(HistoryQuerySchema)(value)

export const decodeMarkSessionReadResponseEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(MarkSessionReadResponseSchema)(value)

/** @internal Compile-time check that the schema and the type agree. */
export type ChatReceiptStatusAgrees = Assert<
  Agrees<(typeof ChatReceiptStatusSchema)["Type"], ChatReceiptStatus>
>

export { QuestionAnswerSchema } from "./schema-fields.js"
