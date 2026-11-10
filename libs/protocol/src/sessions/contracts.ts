import type { SessionPresentation } from "./presentation.js"
import type { ContextBudgetSnapshot } from "../chat/history.js"
import type { JsonRecord } from "../common/json.js"
import type { RuntimeRunStatus } from "../chat/runtime.js"

/** Semantic options accepted by `sessionRoutes.list`. */
export interface SessionListOptions {
  readonly spaceId?: string
  readonly inbox?: boolean
  readonly scope?: SessionListScope
  /** Only sessions whose latest run is still open. The set is bounded by
   *  concurrency rather than history, which is what makes hydrating all of them
   *  affordable where paging every stored agent is not. */
  readonly live?: boolean
  /** Only the direct children of these sessions. */
  readonly parentSessionIds?: ReadonlyArray<string>
  readonly limit?: number
  readonly offset?: number
  readonly sort?: SessionListSort
  readonly cursor?: SessionListCursor
  readonly sessionIds?: ReadonlyArray<string>
  readonly sessionRef?: string
}

/** Which session kinds a listing may return. Spawned agent sessions vastly
 *  outnumber conversations, so a page shared between them starves the rail:
 *  the caller states which population it is paging, and the filter lands in
 *  SQL before ORDER BY and the cursor. */
/** Primary contains owner conversations only; channels and child runs use all. */
export type SessionListScope = "primary" | "agent" | "all"

export type SessionListSort = "activity" | "accessed"

export interface SessionListCursor extends JsonRecord {
  readonly at: string
  readonly session_id: string
}

/** Complete row returned by `GET /sessions`; event projections may be lighter. */
export interface ListedSession extends SessionListItem {
  readonly presentation: SessionPresentation
  readonly public_ref: string | null
  readonly last_accessed_at: string | null
  readonly has_unread: boolean
  readonly space_id: string | null
  readonly chat_model: string | null
  readonly session_type: SessionType
  readonly origin_automation_id: string | null
  readonly parent_session_id: string | null
  readonly parent_tool_call_id: string | null
  readonly parent_message_id: string | null
  readonly parent_run_id: string | null
  readonly active_run_id: string | null
  readonly active_turn_id: string | null
  readonly run_status: RuntimeRunStatus | null
  readonly checkpoint_seq: number
  readonly latest_event_seq: number
  readonly is_active: boolean
  readonly pending_approvals_count: number
  readonly pending_connections_count: number
  readonly run_error_code: string | null
  readonly run_stop_reason: string | null
}

export interface SessionListResponse extends JsonRecord {
  readonly sessions: ReadonlyArray<ListedSession>
  readonly next_cursor: SessionListCursor | null
}

export interface CreateSessionRequest {
  readonly name?: string | null
  readonly space_id?: string | null
  /** Pins the Session's Chat model from birth; null or absent inherits the global one. */
  readonly chat_model?: string | null
  /** `capture`: a screenshot handed to Arden (⇧ + both ⌘). The chat runs on the
   *  Helper model unless `chat_model` names one, and loose-chat triage leaves it
   *  alone: the chat itself decides where the capture goes.
   *  `onboarding`: the first-run "Getting started" chat; Arden speaks first and
   *  walks a new user through setup in it. */
  readonly origin?: "capture" | "onboarding"
}

/** A screenshot handed to Arden (⇧ + both ⌘), with the user's note, for `POST /captures`. */
export interface HandCaptureRequest {
  /** The desktop's id for this press: a retry routes and delivers once. */
  readonly capture_id: string
  readonly image: { readonly media_type: "image/png" | "image/jpeg"; readonly data: string }
  readonly note: string
}

/**
 * Where a capture went. `moved`: the router matched the chat it belongs to and delivered it
 * there as the user's message (`client_id` reverts it). `kept`: a new capture chat (only when no Space exists), where the
 * agent now works on it; `line` is the router's description when it had one.
 */
export type HandCaptureResponse =
  | {
      readonly kind: "moved"
      readonly session_id: string
      readonly name: string
      readonly line: string
      readonly client_id: string
    }
  | { readonly kind: "kept"; readonly session_id: string; readonly line: string | null }

export interface CreateSessionResponse extends JsonRecord {
  readonly session_id: string
  readonly name: string | null
  readonly started_at: string
  readonly last_activity: string
  readonly message_count: number
  readonly space_id: string | null
  readonly chat_model: string | null
  /** The job the chat was made for, as on its list row (`SessionListItem.origin`). */
  readonly origin: "capture" | "onboarding" | null
}

/** Stable context origin, separate from execution ownership and resource grants. */
export interface SessionForkOrigin extends JsonRecord {
  readonly sourceSessionId: string
  readonly sourceSessionRef: string | null
  readonly throughSequence: number
  readonly sourceMessageId: string | null
  readonly createdAt: string
}

export interface BranchSessionRequest {
  readonly disposition?: "retained" | "disposable"
  readonly request_id?: string
  readonly share_resources?: boolean
  readonly name?: string | null
  readonly up_to_message_id?: string | null
}

export interface BranchSessionResponse extends JsonRecord {
  readonly fork_origin?: SessionForkOrigin | null
  readonly session_id: string
  readonly name: string | null
  readonly started_at: string
  readonly last_activity: string
  readonly space_id: string | null
}

export interface RenameSessionRequest {
  readonly name: string
}

export interface RenameSessionResponse extends JsonRecord {
  readonly session_id: string
  readonly name: string
}

export interface UpdateSessionModelRequest {
  readonly chat_model: string | null
}

export interface UpdateSessionModelResponse extends JsonRecord {
  readonly session_id: string
  readonly chat_model: string | null
  readonly context_budget: ContextBudgetSnapshot
}

export interface ArchivedSession extends JsonRecord {
  readonly session_id: string
  readonly public_ref: string | null
  readonly started_at: string
  readonly last_activity: string
  readonly last_accessed_at: string | null
  readonly name: string | null
  readonly archived_at: string
  /** The opening words of the chat's first message, for a chat with no name. */
  readonly first_line: string | null
  readonly message_count: number
  readonly space_id: string | null
  readonly chat_model: string | null
  readonly session_type: SessionType
  readonly origin_automation_id: string | null
  readonly parent_session_id: string | null
  readonly parent_tool_call_id: string | null
  readonly parent_message_id: string | null
  readonly parent_run_id: string | null
}

export interface ArchivedSessionsResponse extends JsonRecord {
  readonly sessions: ReadonlyArray<ArchivedSession>
}

export type SessionLifecycleStatus = "archived" | "restored" | "continued" | "deleted"

export interface SessionLifecycleResponse extends JsonRecord {
  readonly status: SessionLifecycleStatus
  readonly session_id: string
}

/** What a chat still has running, by kind: its own replies (paused or
 *  waiting ones too), its agents at any depth, the runs of Automations that
 *  live in it, workflows and terminal commands. */
export interface ChatRunningWork extends JsonRecord {
  readonly replies: number
  readonly agents: number
  readonly automations: number
  readonly workflows: number
  readonly commands: number
}

/** The 409 of an archive or a permanent delete: the reason worded for the
 *  user, and what runs when only running work refused it. Sending the same
 *  request with `stop=true` stops that work first. */
export interface SessionEndConflict extends JsonRecord {
  readonly detail: string
  readonly running: ChatRunningWork | null
}

export interface ClearSessionRequest {
  readonly session_id?: string | null
}

export interface ClearSessionResponse extends JsonRecord {
  readonly status: "cleared"
  readonly session_id: string | null
}

export interface RevertSessionRequest {
  readonly session_id?: string | null
  readonly turns?: number
  readonly message_id?: string | null
}

export interface RevertSessionResponse extends JsonRecord {
  readonly user_message: string
  readonly reverted_count: number
}

export interface MoveSessionToSpaceRequest {
  readonly space_id: string | null
}

export interface MoveSessionToSpaceResponse extends JsonRecord {
  readonly session_id: string
  readonly space_id: string | null
}

export type SessionExportFormat = "archive" | "markdown" | "json" | "jsonl"

/** Rendered by the server, then handed to the Desktop download flow. */
export interface SessionExportResponse extends JsonRecord {
  readonly format: SessionExportFormat
  readonly filename: string
  readonly media_type:
    | "application/vnd.arden.session+json"
    | "application/json"
    | "application/x-ndjson"
    | "text/markdown"
  readonly content: string
  readonly warnings: ReadonlyArray<string>
}

/** One conversation message of a chat that holds the find query, and how many
 *  times (`findTextRanges`). */
export interface ChatFindHit extends JsonRecord {
  readonly message_id: string
  readonly seq: number
  readonly count: number
}

/** `GET /sessions/:id/find`: every conversation message of one chat that holds
 *  the query, oldest first, loaded or not. `truncated` says the chat had more
 *  than the server reads or returns in one find. */
export interface ChatFindResponse extends JsonRecord {
  readonly hits: ReadonlyArray<ChatFindHit>
  readonly truncated: boolean
}

/** One message that matches a find across all chats. */
export interface ChatSearchHit extends JsonRecord {
  readonly message_id: string
  /** One line of the message, cut to start a little before its first match. */
  readonly snippet: string
  /** Each match in `snippet`, as [start, end) offsets, to highlight. */
  readonly ranges: ReadonlyArray<readonly [start: number, end: number]>
  readonly created_at: string
}

interface ChatSearchChatBase extends JsonRecord {
  readonly session_id: string
  readonly session_name: string | null
  /** Each match in `session_name`, as [start, end) offsets; empty when it does not match. */
  readonly name_ranges: ReadonlyArray<readonly [start: number, end: number]>
  readonly last_activity: string
}

/** A chat with a matching message, its newest one in `hit`; its name may match too. */
export interface ChatSearchByMessage extends ChatSearchChatBase {
  readonly match: "message"
  readonly hit: ChatSearchHit
}

/** A chat whose name matches and no message does; `preview` is its newest message
 * (no `ranges`), null when it has none to show. */
export interface ChatSearchByName extends ChatSearchChatBase {
  readonly match: "name"
  readonly preview: ChatSearchHit | null
}

/** One chat that matches a find across all chats. */
export type ChatSearchChat = ChatSearchByMessage | ChatSearchByName

/** `GET /sessions/search`: chats whose name matches first, then chats whose messages
 * match, the chat with the newest match first. One entry per chat. */
export interface ChatSearchResponse extends JsonRecord {
  readonly chats: ReadonlyArray<ChatSearchChat>
  readonly has_more: boolean
}

export interface SessionTriageTarget extends JsonRecord {
  readonly space_id: string
  readonly title: string
}

export interface MoveSessionTriageDecision extends JsonRecord {
  readonly decision: "move"
  readonly target: SessionTriageTarget
  readonly new_title: null
  readonly rationale: string
}

export interface CreateSessionTriageDecision extends JsonRecord {
  readonly decision: "create"
  readonly target: null
  readonly new_title: string
  readonly rationale: string
}

export interface NoSessionTriageDecision extends JsonRecord {
  readonly decision: "none"
  readonly target: null
  readonly new_title: null
  readonly rationale: string
}

/** Triage filed the Chat on this Space: automatically for a certain fit, or
 *  because the user accepted the suggestion ("Make it a space" names the Space
 *  it made, whose conversation the Chat now is). */
export interface MovedSessionTriageDecision extends JsonRecord {
  readonly decision: "moved"
  readonly target: SessionTriageTarget
  readonly new_title: null
  readonly rationale: string
}

export type SessionTriageDecision =
  | MoveSessionTriageDecision
  | CreateSessionTriageDecision
  | NoSessionTriageDecision
  | MovedSessionTriageDecision

/** What the user did with a suggestion: "Not this", Move / Make it a space, or
 *  Undo of a filing triage made. The server remembers each one. */
export type SessionTriageAction = "dismiss" | "accept" | "undo"

export interface SessionTriageActionRequest {
  readonly action: SessionTriageAction
}

export type SessionType = "chat" | "channel" | "agent"

/** Where a forked agent's history came from: the parent turn it forked in, and when. */
export interface SessionFork extends JsonRecord {
  readonly at: string
  readonly turn_id: string
}

/** The chat a thread's own chat was opened from. */
export interface SessionThreadSource extends JsonRecord {
  readonly session_id: string
  readonly session_ref: string | null
}

export interface SessionListItem extends JsonRecord {
  readonly current_activity?: import("../chat/activity.js").RunActivity | null
  /** Initial working directory recorded for a code agent; absent for other chats. */
  readonly agent_workspace?: string | null
  readonly latest_run_id?: string | null
  readonly presentation?: SessionPresentation
  readonly session_id: string
  readonly public_ref?: string | null
  readonly started_at: string
  readonly last_activity: string
  readonly last_accessed_at?: string | null
  readonly has_unread?: boolean
  readonly name: string | null
  readonly message_count: number
  readonly space_id?: string | null
  readonly chat_model?: string | null
  readonly session_type?: SessionType
  readonly origin_automation_id?: string | null
  readonly parent_session_id?: string | null
  readonly parent_tool_call_id?: string | null
  readonly parent_message_id?: string | null
  readonly parent_run_id?: string | null
  readonly active_run_id?: string | null
  readonly active_turn_id?: string | null
  readonly run_status?: RuntimeRunStatus | null
  readonly checkpoint_seq?: number
  readonly latest_event_seq?: number
  readonly is_active?: boolean
  readonly pending_approvals_count?: number
  readonly pending_connections_count?: number
  readonly run_error_code?: string | null
  readonly run_stop_reason?: string | null
  /** The stored filing suggestion while it is fresh; `null` when the Chat was
   *  never checked or has grown (or moved to a new day) since its check. */
  readonly triage?: SessionTriageDecision | null
  /** Set on an agent that started from its parent's conversation (spawn_agent fork_context). */
  readonly fork?: SessionFork | null
  readonly fork_origin?: SessionForkOrigin | null
  /** Set on a chat opened for a thread from another chat (a Focus choice). */
  readonly thread_source?: SessionThreadSource | null
  /** What the chat covered, from its Chat summary; null until it has one. */
  readonly summary?: string | null
  /** The job the chat was made for (CreateSessionRequest.origin); null for an ordinary chat. */
  readonly origin?: "capture" | "onboarding" | null
}
