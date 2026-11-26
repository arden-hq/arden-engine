import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ChatProjectionEvent } from "./events/stream.js"
import type { ApprovalMode } from "../permissions/modes.js"
import type { JsonRecord, JsonValue } from "../common/json.js"
import type { HistoryImage, HistoryImageMediaType } from "./history.js"
import type { SentFrom } from "./history-message.js"

export type AgentMode = "research" | "code" | "work"
export type ChatApprovalMode = ApprovalMode

/**
 * Stream events that are lossy live presentation: the server assigns them a
 * sequence and publishes them to attached followers, but never journals them
 * durably. Whatever matters is restated — by a terminal event
 * (TEXT_MESSAGE_CONTENT -> TEXT_MESSAGE_END.content, REASONING_MESSAGE_CONTENT
 * -> REASONING_MESSAGE_END.content, TOOL_CALL_OUTPUT_DELTA ->
 * TOOL_CALL_RESULT.content), by the durable transcript (TOOL_CALL_ARGS), or
 * not at all
 * (TOOL_CALL_PROGRESS, stream_retry — fire-and-forget status), or by the
 * history header (token_usage: the session's stored last_input_tokens and
 * message count restate context pressure on every load). Clients must
 * never rely on replay carrying any of these types; a server may still choose
 * to persist an individual event (a backgrounded workflow's detached progress),
 * which is a persistence refinement, not a wire guarantee.
 * Mirrored by the delta contract on the event schemas in `schema.ts`.
 */
export const EPHEMERAL_CHAT_EVENT_TYPES = [
  "TEXT_MESSAGE_CONTENT",
  "REASONING_MESSAGE_CONTENT",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_OUTPUT_DELTA",
  "TOOL_CALL_PROGRESS",
  "run_activity",
  "input_taken",
  "stream_retry",
  "token_usage"
] as const satisfies ReadonlyArray<ChatProjectionEvent["type"]>

export type EphemeralChatEventType = (typeof EPHEMERAL_CHAT_EVENT_TYPES)[number]

const ephemeralChatEventTypes: ReadonlySet<string> = new Set(EPHEMERAL_CHAT_EVENT_TYPES)

export const isEphemeralChatEvent = <Event extends { readonly type: string }>(
  event: Event
): event is Extract<Event, { readonly type: EphemeralChatEventType }> =>
  ephemeralChatEventTypes.has(event.type)

/** Canonical metadata persisted in a successful spawn_agent tool result. */
export interface PersistedChildAgentMetadata extends JsonRecord {
  readonly session_id: string
  readonly session_ref: string
  readonly run_id: string
  readonly status: "running"
  readonly mode: AgentMode
}

export interface ChatImageInput {
  readonly mediaType: HistoryImageMediaType
  /** Base64 bytes without a data-URL prefix. */
  readonly data: string
}

/** Snapshot shown to the model with a human reply. */
export interface ChatReplyContext extends JsonRecord {
  readonly messageId: string
  readonly role: typeof ROLE.user | typeof ROLE.assistant
  readonly content: string
}

/** How many messages one reply can quote. */
export const CHAT_REPLY_QUOTES_MAX = 10

/** Every message a reply quotes, in the order they were quoted. */
export const chatReplyContexts = (
  replyTo: ChatReplyContext | ReadonlyArray<ChatReplyContext> | undefined
): ReadonlyArray<ChatReplyContext> => {
  if (replyTo === undefined) return []
  return "messageId" in replyTo ? [replyTo] : replyTo
}

/** A message sent as a capture: the quick-capture window, or iPhone. */
export type ChatCaptureVia = "quick" | "phone"

export const APPROVAL_REPLY = { none: "none", deny: "deny" } as const

export type ApprovalReply =
  | { readonly kind: typeof APPROVAL_REPLY.none }
  | { readonly kind: typeof APPROVAL_REPLY.deny; readonly runId: string; readonly toolId: string }

export const REQUESTED_MODE = { current: "current", mode: "mode" } as const

export type RequestedApprovalMode =
  | { readonly kind: typeof REQUESTED_MODE.current }
  | { readonly kind: typeof REQUESTED_MODE.mode; readonly mode: ChatApprovalMode }

export const CHAT_CAPTURE = { none: "none", capture: "capture" } as const

export type ChatCapture =
  | { readonly kind: typeof CHAT_CAPTURE.none }
  | { readonly kind: typeof CHAT_CAPTURE.capture; readonly via: ChatCaptureVia }

export const ANSWER_SHAPE = { free: "free", schema: "schema" } as const

export type AnswerShape =
  | { readonly kind: typeof ANSWER_SHAPE.free }
  | {
      readonly kind: typeof ANSWER_SHAPE.schema
      readonly schema: { readonly [key: string]: JsonValue }
    }

export interface ChatMessageInput {
  readonly sessionId: string
  readonly clientId: string
  readonly message: string
  readonly images: ReadonlyArray<ChatImageInput>
  readonly replyTo: ReadonlyArray<ChatReplyContext>
  readonly approvalReply: ApprovalReply
  readonly approvalMode: RequestedApprovalMode
  readonly sentFrom: SentFrom
  readonly capture: ChatCapture
  readonly outputSchema: AnswerShape
}

/** One reusable message body plus its generated correlation identity. */
export interface PreparedChatMessage {
  readonly body: string
  readonly clientId: string
}

export const STANDING_GRANT = { once: "once", standing: "standing" } as const

export const GRANT_LIST = { cardDefault: "default", space: "space", global: "global" } as const

export type GrantList = (typeof GRANT_LIST)[keyof typeof GRANT_LIST]

export type StandingGrant =
  | { readonly kind: typeof STANDING_GRANT.once }
  | { readonly kind: typeof STANDING_GRANT.standing; readonly list: GrantList }

export const TOOL_DECISION = {
  unstated: "unstated",
  denied: "denied",
  approved: "approved"
} as const

export const FOLDER_ATTACH = { keep: "keep", attach: "attach" } as const

export const ARGUMENT_EDITS = { asAsked: "as_asked", edited: "edited" } as const

export type ArgumentEdits =
  | { readonly kind: typeof ARGUMENT_EDITS.asAsked }
  | {
      readonly kind: typeof ARGUMENT_EDITS.edited
      readonly arguments: { readonly [key: string]: JsonValue }
    }

export const APPROVED_AS = { asAsked: "as_asked", draft: "draft" } as const

export type ApprovedAs = (typeof APPROVED_AS)[keyof typeof APPROVED_AS]

export type ToolDecision =
  | { readonly kind: typeof TOOL_DECISION.unstated; readonly grant: StandingGrant }
  | { readonly kind: typeof TOOL_DECISION.denied; readonly grant: StandingGrant }
  | {
      readonly kind: typeof TOOL_DECISION.approved
      readonly grant: StandingGrant
      readonly folder: (typeof FOLDER_ATTACH)[keyof typeof FOLDER_ATTACH]
      readonly edits: ArgumentEdits
      readonly as: ApprovedAs
    }

export const DECISION_ASKED = { unstated: "unstated", at: "at" } as const

export type DecisionAsked =
  | { readonly kind: typeof DECISION_ASKED.unstated }
  | { readonly kind: typeof DECISION_ASKED.at; readonly at: string }

export const RELAY_COMMAND = { none: "none", command: "command" } as const

export type RelayCommand =
  | { readonly kind: typeof RELAY_COMMAND.none }
  | { readonly kind: typeof RELAY_COMMAND.command; readonly id: string }

export interface ToolResultInput {
  readonly runId: string
  readonly toolId: string
  readonly result: string
  readonly decision: ToolDecision
  readonly asked: DecisionAsked
  readonly command: RelayCommand
}

/** The rules list a card's "Always allow" saves to (see `ToolResultInput`). */
export type StandingRuleList = "space" | "global"

/** What a card may choose instead of the call as asked (see `ToolResultInput`). */
export type ToolApprovalAlternative = "draft"

/** Values accepted by `POST /connections/result`. */
export interface ConnectionResultInput {
  readonly runId: string
  readonly toolId: string
  readonly connectionId: string
  readonly result: ConnectionResultText
  readonly approved: boolean
}

export const CONNECTION_RESULT = { cardDefault: "default", stated: "stated" } as const

export type ConnectionResultText =
  | { readonly kind: typeof CONNECTION_RESULT.cardDefault }
  | { readonly kind: typeof CONNECTION_RESULT.stated; readonly text: string }

export const CANCEL_TARGET = { run: "run", session: "session" } as const

export type CancelInput =
  | { readonly kind: typeof CANCEL_TARGET.run; readonly runId: string }
  | {
      readonly kind: typeof CANCEL_TARGET.session
      readonly sessionId: string
      readonly holdQueue: boolean
    }

export const CHAT_RECEIPT_STATUS = {
  running: "running",
  queued: "queued",
  ingested: "ingested",
  accepted: "accepted",
  cancelled: "cancelled",
  busy: "busy",
  steered: "steered",
  active: "active",
  resumed: "resumed",
  completed: "completed",
  error: "error",
  failed: "failed",
  interrupted: "interrupted"
} as const

export type ChatReceiptStatus =
  | "running"
  | "queued"
  | "ingested"
  | "accepted"
  | "cancelled"
  | "busy"
  | "steered"
  | "active"
  | "resumed"
  | "completed"
  | "error"
  | "failed"
  | "interrupted"

/**
 * What a sent message did. `started`: it began a new Run. `steered`: a Run was
 * already going in the chat and the message joined it; the model reads it
 * before its next step. A message that must wait for the Run to end goes to the
 * chat's queue instead (`POST /sessions/:id/queue`).
 */
export const CHAT_DELIVERY = { started: "started", steered: "steered", none: "none" } as const

export type ChatDelivery = (typeof CHAT_DELIVERY)[keyof typeof CHAT_DELIVERY]

export const chatDelivery = (status: ChatReceiptStatus): ChatDelivery => {
  if (status === CHAT_RECEIPT_STATUS.running) return CHAT_DELIVERY.started
  if (status === CHAT_RECEIPT_STATUS.queued) return CHAT_DELIVERY.steered
  return CHAT_DELIVERY.none
}

/** Receipt returned by `POST /chat/message`. Busy has no run identity. */
export const RECEIPT_RUN = { none: "none", run: "run" } as const

export type ReceiptRun =
  | { readonly kind: typeof RECEIPT_RUN.none }
  | { readonly kind: typeof RECEIPT_RUN.run; readonly runId: string }

export interface ChatReceipt extends JsonRecord {
  readonly run: ReceiptRun
  readonly sessionId: string
  readonly status: ChatReceiptStatus
  readonly delivery: ChatDelivery
  readonly clientId: string
}

export interface ChatAcknowledgement extends JsonRecord {
  readonly status: "ok"
}

export interface CancelResponse extends JsonRecord {
  readonly status: "cancelling"
  readonly runId: string
  readonly cancelRequested: boolean
}

/** Only live runs are returned by `GET /chat/runs/status`. */
export type ActiveRunStatus = "pending" | "running"

export interface ActiveRunSummary extends JsonRecord {
  readonly runId: string
  readonly turnId: string
  readonly sessionId: string
  readonly status: ActiveRunStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly ageSeconds: number
  readonly idleSeconds: number
  readonly messageCount: number
  readonly pendingInjections: number
  readonly approvalsPending: number
}

export interface RunsStatus extends JsonRecord {
  readonly observedAt: string
  readonly totalRetained: number
  readonly activeRuns: ReadonlyArray<ActiveRunSummary>
}

export interface QueuedCancelResponse extends JsonRecord {
  readonly status: "cancelled"
  readonly clientId: string
}

export const CHAT_MESSAGE_MAX_LENGTH = 100_000

/**
 * How many fresh turns one Session may park behind its active run. The composer
 * enforces the same number before it ever calls the server; this is the durable
 * ceiling, so a second client cannot grow the queue past what the composer can
 * show.
 */
export const CHAT_QUEUE_LIMIT = 10

/** One parked turn: composed, not sent, and durable across a reload. */
export interface QueuedChatMessage extends JsonRecord {
  readonly client_id: string
  readonly message: string
  readonly images: ReadonlyArray<HistoryImage>
  readonly enqueued_at: string
  readonly sent_from: SentFrom
  readonly failure: QueuedFailure
}

export const QUEUED_FAILURE = { none: "none", failed: "failed" } as const

export type QueuedFailure =
  | { readonly kind: typeof QUEUED_FAILURE.none }
  | { readonly kind: typeof QUEUED_FAILURE.failed; readonly reason: string }

export interface QueuedChatMessages extends JsonRecord {
  readonly session_id: string
  readonly messages: ReadonlyArray<QueuedChatMessage>
}

/** Values accepted by `POST /sessions/:sessionId/queue`. The client id is the
 *  one the composer already minted, so the eventual send stays idempotent. */
export interface EnqueueChatMessageInput {
  readonly sessionId: string
  readonly clientId: string
  readonly message: string
  readonly images: ReadonlyArray<ChatImageInput>
  readonly sentFrom: SentFrom
}

/** Complete desired order; rejects membership changed by another queue operation. */
export interface ReorderChatQueueInput {
  readonly sessionId: string
  readonly clientIds: ReadonlyArray<string>
}

export interface ReadResponse extends JsonRecord {
  readonly sessionId: string
  readonly hasUnread: boolean
}

export const HISTORY_PAGE_LIMIT = 100

export const HISTORY_WINDOW = {
  latest: "latest",
  before: "before",
  after: "after",
  around: "around",
  aroundSeq: "around_seq"
} as const

export type TurnWorkWindow =
  | { readonly kind: typeof HISTORY_WINDOW.latest }
  | { readonly kind: typeof HISTORY_WINDOW.before; readonly cursor: string }
  | { readonly kind: typeof HISTORY_WINDOW.after; readonly cursor: string }

export type HistoryWindow =
  | TurnWorkWindow
  | { readonly kind: typeof HISTORY_WINDOW.around; readonly cursor: string }
  | { readonly kind: typeof HISTORY_WINDOW.aroundSeq; readonly seq: number }

export interface HistoryRouteOptions {
  readonly sessionId: string
  readonly limit: number
  readonly window: HistoryWindow
}

export type TurnWorkView = "full" | "compact"

export const TURN_WORK_VIEW = { full: "full", compact: "compact" } as const

export interface TurnWorkRouteOptions {
  readonly sessionId: string
  readonly turnId: string
  readonly limit: number
  readonly window: TurnWorkWindow
  readonly view: TurnWorkView
}

/** Options for `GET /session/turn-details`. */
export interface TurnDetailsRouteOptions {
  readonly sessionId: string
  readonly turnId: string
}

export interface ToolCallRouteOptions {
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
}

/** One value from a tool call's result in this chat (an answer block's
 *  `Query("tool_result", …)`); never another chat's, never a new call. */
export interface ToolResultValueRouteOptions {
  readonly sessionId: string
  readonly toolCallId: string
  readonly path: string
}

/** One call in full, for the viewer: what the model sent and what came back. */
export interface ToolCallResponse extends JsonRecord {
  readonly tool_call_id: string
  readonly name: string
  readonly arguments: string
  readonly result: ToolCallReturn
  readonly is_error: boolean
}

export const TOOL_CALL_RETURN = { pending: "pending", returned: "returned" } as const

export type ToolCallReturn =
  | { readonly kind: typeof TOOL_CALL_RETURN.pending }
  | { readonly kind: typeof TOOL_CALL_RETURN.returned; readonly text: string }

export const callResult = (text: string | undefined): ToolCallReturn =>
  text === undefined
    ? { kind: TOOL_CALL_RETURN.pending }
    : { kind: TOOL_CALL_RETURN.returned, text }

export interface ReadAddress {
  readonly sessionId: string
}

export interface QueuedMessageAddress {
  readonly clientId: string
  readonly sessionId: string
}

export type {
  ActiveWork,
  AgentResult,
  ChatSentFrom,
  ConnectionArrival,
  ContextBudgetSnapshot,
  GmailSendReceipt,
  HistoryAssistantOutputPart,
  HistoryContextBlock,
  HistoryImage,
  HistoryImageMediaType,
  HistoryMessage,
  HistoryPage,
  HistoryResponse,
  HistoryToolCall,
  Interaction,
  InteractionActor,
  InteractionKind,
  InteractionOutcome,
  InteractionRecipient,
  InteractionReference,
  InteractionSender,
  InteractionSource,
  ActorName,
  InteractionPreview,
  SenderAddress,
  SenderCause,
  PageBounds,
  ToolCountName,
  TurnEnding,
  TurnShell,
  TurnToolCallCount,
  TurnWorkResponse,
  TurnDetailsResponse
} from "./history.js"
