import { SERVER_EVENT_TYPE } from "../common/event-types.js"
import type { AppDestination, NavigationAskedBy } from "../common/navigation.js"
import type {
  EntityChangeTarget,
  LinkedAutomation,
  LinkedChat,
  LinkedTask,
  TaskSpace
} from "../common/links.js"
export * from "../common/links.js"
import type { EventFrame, Framed } from "../common/event-fields.js"
import type { JsonRecord } from "../common/json.js"
import type { SessionListItem } from "../sessions/contracts.js"
import type { ChatServerEvent, StreamKeepaliveEvent } from "../chat/events/stream.js"
import type { AutomationRunOutcome } from "../automations/outcome.js"

export interface StreamResetEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.streamReset
  readonly session_id: string
  readonly seq: number
  readonly reason: "future_cursor" | "replay_gap"
}

export interface AutomationProgressEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.automationProgress
  readonly task_id: string
  readonly status: string
}

export interface AutomationFinishedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.automationFinished
  readonly task_id: string
  readonly outcome: AutomationRunOutcome | "completed"
  readonly run_chat: LinkedChat
}

export const RECORD_TOLD_STATUS = {
  finished: "finished",
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
  silent: "silent",
  waiting: "waiting",
  done: "done",
  paused: "paused",
  posted: "posted"
} as const

export type RecordToldStatus = (typeof RECORD_TOLD_STATUS)[keyof typeof RECORD_TOLD_STATUS]

export interface RecordToldEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.recordTold
  readonly key: string
  readonly record: "ending" | "entity"
  readonly status: RecordToldStatus
  readonly shown: boolean
  readonly unread: boolean
  readonly title: string
  readonly text: string
  readonly chat: LinkedChat
  readonly automation: LinkedAutomation
  readonly task: LinkedTask
}

export interface SessionCreatedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.sessionCreated
  readonly session: SessionListItem
}

export interface SessionActivityEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.sessionActivity
  readonly session: SessionListItem
}

export interface ChatInputCommittedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.chatInputCommitted
  readonly chat_session_id: string
  readonly run_id: string
}

export interface SessionBlockingWorkEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.sessionBlockingWork
  readonly session_id: string
  readonly blocking_work: boolean
}

export interface McpServerChangedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.mcpServerChanged
  readonly server: string
}

export type EntityKind = "session" | "space" | "automation" | "permission" | "task" | "proposal"

export interface EntityChangedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.entityChanged
  readonly kind: EntityKind
  readonly target: EntityChangeTarget
}

export const NAVIGATION_MODE = { offer: "offer", open: "open" } as const

export type NavigationMode = (typeof NAVIGATION_MODE)[keyof typeof NAVIGATION_MODE]

export interface NavigationRequestedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.navigationRequested
  readonly origin_session_id: string
  readonly destination: AppDestination
  readonly label: string
  readonly mode: NavigationMode
  readonly asked_by: NavigationAskedBy
}

export interface QuestionChangedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.questionChanged
  readonly question_id: string
  readonly run_id: string
  readonly session_id: string
  readonly task: LinkedTask
}

export interface TaskVisibilityChangedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.taskVisibilityChanged
  readonly space: TaskSpace
  readonly item_id: string
}

export interface WorkChangedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.workChanged
  readonly space: TaskSpace
  readonly item_id: string
  readonly change: "comment" | "status"
}

export interface TaskProposalChangedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.taskProposalChanged
  readonly space_id: string
  readonly proposal_id: string
  readonly revision: number
  readonly status: "offered" | "accepted" | "rejected" | "expired" | "retired"
}

export interface FocusChoiceChangedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.focusChoiceChanged
  readonly space_id: string
  readonly question_id: string
  readonly revision: number
  readonly status: "offered" | "settled"
}

interface TaskWorkEventFields extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.taskWorkChanged
  readonly space: TaskSpace
  readonly item_id: string
  readonly task_name: string
  readonly run_session_id: string
  readonly chat_run_id: string
  readonly started_at: string
}

export const TASK_WORK_STATE = { running: "running", ended: "ended" } as const

export interface TaskWorkRunningEvent extends TaskWorkEventFields {
  readonly state: typeof TASK_WORK_STATE.running
  readonly phase: "pending" | "running"
  readonly ended_at: null
  readonly outcome: null
}

export interface TaskWorkEndedEvent extends TaskWorkEventFields {
  readonly state: typeof TASK_WORK_STATE.ended
  readonly phase: typeof TASK_WORK_STATE.ended
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

export type LifecycleFeedBody = Exclude<AutomationEvent, StreamKeepaliveEvent | StreamResetEvent>

export type ServerEvent = ChatServerEvent | Framed<LifecycleFeedBody, EventFrame> | StreamResetEvent
