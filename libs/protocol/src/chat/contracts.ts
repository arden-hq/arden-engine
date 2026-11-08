import type { ChatProjectionEvent } from "./events/stream.js"
import type { ApprovalMode } from "../permissions/modes.js"
import type { JsonRecord, JsonValue } from "../common/json.js"
import type { ChatSentFrom, HistoryImage, HistoryImageMediaType } from "./history.js"

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
  readonly role: "user" | "assistant"
  readonly content: string
}

/** A message sent as a capture: the quick-capture window, or iPhone. */
export type ChatCaptureVia = "quick" | "phone"

export interface ChatMessageInput {
  readonly sessionId: string
  /** Stable caller-owned identity reused by retries, edits, and queued sends. */
  readonly clientId?: string
  readonly message: string
  readonly images?: ReadonlyArray<ChatImageInput>
  readonly replyTo?: ChatReplyContext
  /** The exact visible approval this typed reply denies. */
  readonly approvalReply?: { readonly runId: string; readonly toolId: string }
  /** Approval policy captured for the run started by this message. */
  readonly approvalMode?: ChatApprovalMode
  /** The Recipe the user started this message from, by its Skill name. */
  readonly recipe?: string
  /** The UI surface that wrote this message's words; the person only confirmed it. */
  readonly sentFrom?: ChatSentFrom
  /** Sent as a capture: from the quick-capture window, or from iPhone. Raises `capture.arrived`. */
  readonly capture?: ChatCaptureVia
  /** A JSON Schema the Run's final answer must match; the parsed answer is the result's `data`. */
  readonly outputSchema?: { readonly [key: string]: JsonValue }
}

/** One reusable message body plus its generated correlation identity. */
export interface PreparedChatMessage {
  readonly body: string
  readonly clientId: string
}

/** Values accepted by `POST /tools/result`. */
export interface ToolResultInput {
  readonly runId: string
  readonly toolId: string
  readonly result: string
  readonly approved?: boolean
  readonly grantStanding?: boolean
  /** Where "Always allow" saves: "space" (This Space) or "global" (Everywhere).
   *  Absent, the card's default: the run's Space, else everywhere. */
  readonly grantList?: StandingRuleList
  readonly attachFolderToSpace?: boolean
  /** The card's editable fields as the person left them; a field absent was cleared. */
  readonly editedArguments?: { readonly [key: string]: JsonValue }
  /** The person chose the tool's alternative on the card: `draft` saves the
   *  message as a draft instead of sending it. Requires `approved`. */
  readonly alternative?: ToolApprovalAlternative
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
  readonly result?: string
  readonly approved: boolean
}

/**
 * Cancel either a specific run or the active run for a session. `holdQueue`
 * (a session cancel only) asks the server not to send the chat's queued
 * messages for a short while: an edit sends its own message first.
 */
export type CancelInput =
  | { readonly runId: string; readonly sessionId?: never; readonly holdQueue?: never }
  | { readonly sessionId: string; readonly runId?: never; readonly holdQueue?: boolean }

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

/** Receipt returned by `POST /chat/message`. Busy has no run identity. */
export interface ChatReceipt extends JsonRecord {
  readonly runId: string | null
  readonly sessionId: string
  readonly status: ChatReceiptStatus
  readonly clientId?: string | null
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
  /** The surface that wrote the words, kept so the eventual send carries it. */
  readonly sent_from?: ChatSentFrom
  /** Why the server could not send it. Present until it is sent or cancelled. */
  readonly failed_reason?: string
}

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
  readonly images?: ReadonlyArray<ChatImageInput>
  readonly sentFrom?: ChatSentFrom
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

/** Camel-case query options for `GET /session/history`. */
export interface HistoryRouteOptions {
  readonly sessionId?: string
  readonly limit?: number
  readonly before?: string
  readonly after?: string
  readonly around?: string
  readonly aroundSeq?: number
}

/** Camel-case query options for `GET /session/turn-work`. */
export type TurnWorkView = "full" | "compact"

export interface TurnWorkRouteOptions {
  readonly sessionId: string
  readonly turnId: string
  readonly limit?: number
  readonly before?: string
  /** Page forwards from this cursor; exclusive with `before`. */
  readonly after?: string
  /** `compact` rows carry what a trail row shows; the rest loads on demand. */
  readonly view?: TurnWorkView
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
  readonly result: string | null
  readonly is_error?: boolean
}

export interface ReadAddress {
  readonly sessionId: string
}

export interface QueuedMessageAddress {
  readonly clientId: string
  readonly sessionId: string
}

export type {
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
  InteractionActorType,
  InteractionOutcome,
  InteractionReference,
  TurnShell,
  TurnToolCallCount,
  TurnWorkResponse,
  TurnDetailsResponse
} from "./history.js"
