import type { AppDestination } from "../common/navigation.js"
import type { CommonServerEventFields } from "../common/event-fields.js"
import type { SessionListItem } from "../sessions/contracts.js"
import type { ChatServerEvent, StreamKeepaliveEvent } from "../chat/events/stream.js"
import type { AutomationRunOutcome } from "../automations/outcome.js"

/** Automation-stream only: the Chat detail stream attaches at its captured
 *  head and reports a lost range with `stream_overflow`. */
export interface StreamResetEvent extends CommonServerEventFields {
  readonly type: "stream_reset"
  readonly reason: "future_cursor" | "replay_gap"
}

export interface AutomationProgressEvent extends CommonServerEventFields {
  readonly type: "automation_progress"
  readonly task_id: string
  readonly status: string
}

export interface AutomationFinishedEvent extends CommonServerEventFields {
  readonly type: "automation_finished"
  readonly task_id: string
  /** Whose job it is: one of yours, a Space's or a Task's, or Arden's own. */
  readonly purpose?: "user_automation" | "space_review" | "task_execution" | "system"
  readonly result?: string | null
  /** How the occurrence ended. `completed`: an event journaled before outcomes
   *  were stored, when this said only that the run ended without failing. */
  readonly outcome?: AutomationRunOutcome | "completed"
  readonly error?: string | null
  /** The settled Run and its chat, when the occurrence ran one. */
  readonly run_id?: string | null
  readonly run_session_id?: string | null
}

/** What a record says happened: a run's ending, or an entity's change. */
export type RecordToldStatus =
  | "finished"
  | "blocked"
  | "failed"
  | "cancelled"
  | "silent"
  | "waiting"
  | "done"
  | "paused"

/**
 * A run ending or an entity change was recorded and the owner can see it: as a
 * row in a chat, as the run's own reply, or as an Inbox item. Clients notify from
 * it with `notifyOwner` (`@arden-hq/protocol/notifications`), once per `key`.
 */
export interface RecordToldEvent extends CommonServerEventFields {
  readonly type: "record_told"
  /** `ending:<run id>` for a run, else the entity event's key. */
  readonly key: string
  readonly record: "ending" | "entity"
  readonly status: RecordToldStatus
  /** The owner sees it somewhere; a record only the chat's model is told never notifies. */
  readonly shown: boolean
  /** The chat holds something the owner has not read; read news that finished is not news. */
  readonly unread: boolean
  /** The Automation, Task or chat it is about, by name. */
  readonly title: string
  /** Its words. */
  readonly text: string
  /** Where to open it: the chat it was told in, or the run's own chat. */
  readonly chat_session_id?: string | null
  readonly automation_id?: string | null
  readonly item_id?: string | null
}

export interface SessionCreatedEvent extends CommonServerEventFields {
  readonly type: "session_created"
  readonly session: SessionListItem
}

export interface SessionActivityEvent extends CommonServerEventFields {
  readonly type: "session_activity"
  readonly session: SessionListItem
}

export interface ChatInputCommittedEvent extends CommonServerEventFields {
  readonly type: "chat_input_committed"
  readonly chat_session_id: string
  readonly run_id: string
}

export interface SessionBlockingWorkEvent extends CommonServerEventFields {
  readonly type: "session_blocking_work"
  readonly session_id: string
  readonly blocking_work: boolean
}

/** A connection's state, tools or events changed: whatever shows it reads it again. */
export interface McpServerChangedEvent extends CommonServerEventFields {
  readonly type: "mcp_server_changed"
  readonly server: string
}

/** What an `entity_changed` names; the app knows what to read again for each. */
export type EntityKind = "session" | "space" | "automation" | "permission" | "task" | "proposal"

/** A committed change to one row of `kind` (`id`), or to many (`id` null): whatever
 *  shows it reads it again. The server tells it at commit, whoever wrote. */
export interface EntityChangedEvent extends CommonServerEventFields {
  readonly type: "entity_changed"
  readonly kind: EntityKind
  readonly id: string | null
}

export interface NavigationRequestedEvent extends CommonServerEventFields {
  readonly type: "navigation_requested"
  readonly origin_session_id: string
  readonly destination: AppDestination
  readonly label: string
  /** `offer` only suggests; `open` moves the viewer of the origin Session.
   *  Absent on requests journaled before the choice existed: those opened. */
  readonly mode?: "offer" | "open"
  /** The `app_open` call that asked, so its transcript card can tell the
   *  offer was already taken. */
  readonly tool_call_id?: string
}

export interface QuestionChangedEvent extends CommonServerEventFields {
  readonly type: "question_changed"
  readonly question_id: string
  readonly run_id: string
  readonly session_id: string
  readonly item_id: string | null
}

export interface TaskVisibilityChangedEvent extends CommonServerEventFields {
  readonly type: "task_visibility_changed"
  readonly space_id: string | null
  readonly item_id: string
}

export interface WorkChangedEvent extends CommonServerEventFields {
  readonly type: "work_changed"
  readonly space_id: string | null
  readonly item_id: string
  readonly change: "comment" | "status"
}

export interface TaskProposalChangedEvent extends CommonServerEventFields {
  readonly type: "task_proposal_changed"
  readonly space_id: string
  readonly proposal_id: string
  readonly revision: number
  readonly status: "offered" | "accepted" | "rejected" | "retired"
}

export interface FocusChoiceChangedEvent extends CommonServerEventFields {
  readonly type: "focus_choice_changed"
  readonly space_id: string
  readonly question_id: string
  readonly revision: number
  readonly status: "offered" | "settled"
}

interface TaskWorkEventFields extends CommonServerEventFields {
  readonly type: "task_work_changed"
  readonly space_id: string | null
  readonly item_id: string
  readonly task_name: string
  readonly run_session_id: string
  readonly chat_run_id: string
  readonly started_at: string
}

export interface TaskWorkRunningEvent extends TaskWorkEventFields {
  readonly state: "running"
  readonly phase: "pending" | "running"
  readonly ended_at: null
  readonly outcome: null
}

export interface TaskWorkEndedEvent extends TaskWorkEventFields {
  readonly state: "ended"
  readonly phase: "ended"
  readonly ended_at: string
  readonly outcome: "finished" | "failed" | "stopped"
}

export type TaskWorkChangedEvent = TaskWorkRunningEvent | TaskWorkEndedEvent

export type AutomationEvent =
  | ChatInputCommittedEvent
  | AutomationProgressEvent
  | AutomationFinishedEvent
  | RecordToldEvent
  | SessionCreatedEvent
  | SessionActivityEvent
  | SessionBlockingWorkEvent
  | NavigationRequestedEvent
  | McpServerChangedEvent
  | EntityChangedEvent
  | WorkChangedEvent
  | TaskProposalChangedEvent
  | FocusChoiceChangedEvent
  | TaskWorkChangedEvent
  | TaskVisibilityChangedEvent
  | QuestionChangedEvent
  | StreamKeepaliveEvent
  | StreamResetEvent

/** Complete chat + automation event vocabulary currently used by Arden. */
export type ServerEvent = ChatServerEvent | AutomationEvent
