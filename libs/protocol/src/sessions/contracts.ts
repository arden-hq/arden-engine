import type { SessionPresentation } from "./presentation.js"
import type { ContextBudgetSnapshot } from "../chat/history.js"
import type { JsonRecord } from "../common/json.js"
import type { LinkedAutomation } from "../common/links.js"
import type {
  AgentWorkspace,
  FirstLine,
  ParentMessage,
  SessionActivity,
  SessionChatModel,
  SessionFork,
  SessionName,
  SessionOrigin,
  SessionParent,
  SessionRun,
  SessionSpace,
  SessionSummary,
  SessionThreadSource
} from "./states.js"
export * from "./states.js"

export const SESSION_LIST_FILTER = {
  all: "all",
  space: "space",
  children: "children",
  sessions: "sessions",
  ref: "ref"
} as const

export const SESSION_LIST_NEXT = { end: "end", more: "more" } as const

export const SESSION_LIST_PAGE = { first: "first", offset: "offset", after: "after" } as const

export type SessionListFilter =
  | { readonly kind: typeof SESSION_LIST_FILTER.all }
  | { readonly kind: typeof SESSION_LIST_FILTER.space; readonly space_id: string }
  | {
      readonly kind: typeof SESSION_LIST_FILTER.children
      readonly parent_session_ids: ReadonlyArray<string>
    }
  | {
      readonly kind: typeof SESSION_LIST_FILTER.sessions
      readonly session_ids: ReadonlyArray<string>
    }
  | { readonly kind: typeof SESSION_LIST_FILTER.ref; readonly session_ref: string }

export type SessionListPage =
  | { readonly kind: typeof SESSION_LIST_PAGE.first }
  | { readonly kind: typeof SESSION_LIST_PAGE.offset; readonly offset: number }
  | { readonly kind: typeof SESSION_LIST_PAGE.after; readonly cursor: SessionListCursor }

export interface SessionListOptions {
  readonly scope: SessionListScope
  readonly live: boolean
  readonly limit: number
  readonly sort: SessionListSort
  readonly filter: SessionListFilter
  readonly page: SessionListPage
}

export type SessionListScope = "primary" | "agent" | "all"

export type SessionListSort = "activity" | "accessed"

export interface SessionListCursor extends JsonRecord {
  readonly at: string
  readonly session_id: string
}

export interface ListedSession extends SessionListItem {
  readonly summary: SessionSummary
  readonly agent_workspace: AgentWorkspace
}

export interface SessionListResponse extends JsonRecord {
  readonly sessions: ReadonlyArray<ListedSession>
  readonly next:
    | { readonly kind: typeof SESSION_LIST_NEXT.end }
    | { readonly kind: typeof SESSION_LIST_NEXT.more; readonly cursor: SessionListCursor }
}

export interface CreateSessionRequest {
  readonly name: SessionName
  readonly space: SessionSpace
  readonly chat_model: SessionChatModel
  readonly origin: SessionOrigin
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
  | { readonly kind: "kept"; readonly session_id: string; readonly line: CaptureLine }

export const CAPTURE_LINE = { none: "none", line: "line" } as const

export const keptCapture = (sessionId: string): HandCaptureResponse => ({
  kind: "kept",
  session_id: sessionId,
  line: { kind: CAPTURE_LINE.none }
})

export type CaptureLine =
  | { readonly kind: typeof CAPTURE_LINE.none }
  | { readonly kind: typeof CAPTURE_LINE.line; readonly text: string }

export interface CreateSessionResponse extends JsonRecord {
  readonly session_id: string
  readonly name: SessionName
  readonly started_at: string
  readonly last_activity: string
  readonly message_count: number
  readonly space: SessionSpace
  readonly chat_model: SessionChatModel
  readonly origin: SessionOrigin
}

export const BRANCH_REQUEST = { once: "once", keyed: "keyed" } as const

export type BranchRequestKey =
  | { readonly kind: typeof BRANCH_REQUEST.once }
  | { readonly kind: typeof BRANCH_REQUEST.keyed; readonly request_id: string }

export interface BranchSessionRequest {
  readonly disposition: "retained" | "disposable"
  readonly request: BranchRequestKey
  readonly share_resources: boolean
  readonly name: SessionName
  readonly up_to: ParentMessage
}

export interface BranchSessionResponse extends JsonRecord {
  readonly session_id: string
  readonly name: SessionName
  readonly started_at: string
  readonly last_activity: string
  readonly space: SessionSpace
}

export interface RenameSessionRequest {
  readonly name: string
}

export interface RenameSessionResponse extends JsonRecord {
  readonly session_id: string
  readonly name: string
}

export interface UpdateSessionModelRequest {
  readonly chat_model: SessionChatModel
}

export interface UpdateSessionModelResponse extends JsonRecord {
  readonly session_id: string
  readonly chat_model: SessionChatModel
  readonly context_budget: ContextBudgetSnapshot
}

export interface ArchivedSession extends JsonRecord {
  readonly session_id: string
  readonly public_ref: string
  readonly started_at: string
  readonly last_activity: string
  readonly name: SessionName
  readonly archived_at: string
  readonly first_line: FirstLine
  readonly message_count: number
  readonly space: SessionSpace
  readonly chat_model: SessionChatModel
  readonly session_type: SessionType
  readonly origin_automation: LinkedAutomation
  readonly parent: SessionParent
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
export const RUNNING_WORK = { none: "none", running: "running" } as const

export type SessionEndRunning =
  | { readonly kind: typeof RUNNING_WORK.none }
  | { readonly kind: typeof RUNNING_WORK.running; readonly work: ChatRunningWork }

export interface SessionEndConflict extends JsonRecord {
  readonly detail: string
  readonly running: SessionEndRunning
}

export const SESSION_TARGET = { latest: "latest", session: "session" } as const

export type SessionTarget =
  | { readonly kind: typeof SESSION_TARGET.latest }
  | { readonly kind: typeof SESSION_TARGET.session; readonly session_id: string }

export interface ClearSessionRequest {
  readonly target: SessionTarget
}

export const CLEARED = { none: "none", session: "session" } as const

export interface ClearSessionResponse extends JsonRecord {
  readonly status: "cleared"
  readonly cleared:
    | { readonly kind: typeof CLEARED.none }
    | { readonly kind: typeof CLEARED.session; readonly session_id: string }
}

export const REVERT_TO = { turns: "turns", message: "message" } as const

export interface RevertSessionRequest {
  readonly target: SessionTarget
  readonly to:
    | { readonly kind: typeof REVERT_TO.turns; readonly turns: number }
    | { readonly kind: typeof REVERT_TO.message; readonly message_id: string }
}

export interface RevertSessionResponse extends JsonRecord {
  readonly user_message: string
  readonly reverted_count: number
}

export interface MoveSessionToSpaceRequest {
  readonly space: SessionSpace
}

export interface StartOnboardingResponse extends JsonRecord {
  readonly session_id: string
  readonly started: boolean
}

export interface MoveSessionToSpaceResponse extends JsonRecord {
  readonly session_id: string
  readonly space: SessionSpace
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
  readonly session_name: SessionName
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
  readonly preview: ChatSearchPreview
}

export const SEARCH_PREVIEW = { none: "none", message: "message" } as const

export type ChatSearchPreview =
  | { readonly kind: typeof SEARCH_PREVIEW.none }
  | { readonly kind: typeof SEARCH_PREVIEW.message; readonly hit: ChatSearchHit }

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

export const SESSION_TRIAGE_STATE = { none: "none", decided: "decided" } as const

export type SessionTriageState =
  | { readonly kind: typeof SESSION_TRIAGE_STATE.none }
  | { readonly kind: typeof SESSION_TRIAGE_STATE.decided; readonly decision: SessionTriageDecision }

export interface SessionListItem extends JsonRecord {
  readonly session_id: string
  readonly public_ref: string
  readonly presentation: SessionPresentation
  readonly name: SessionName
  readonly started_at: string
  readonly last_activity: string
  readonly has_unread: boolean
  readonly message_count: number
  readonly space: SessionSpace
  readonly chat_model: SessionChatModel
  readonly session_type: SessionType
  readonly origin_automation: LinkedAutomation
  readonly parent: SessionParent
  readonly run: SessionRun
  readonly checkpoint_seq: number
  readonly latest_event_seq: number
  readonly pending_approvals_count: number
  readonly pending_connections_count: number
  readonly triage: SessionTriageState
  readonly fork: SessionFork
  readonly thread_source: SessionThreadSource
  readonly origin: SessionOrigin
  readonly current_activity: SessionActivity
}
