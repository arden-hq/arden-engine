import type { RunApproval } from "../../runs/approvals.js"
import type { JsonRecord } from "../../common/json.js"

/** Limits enforced by the live Space Work HTTP boundary. */
export const WORK_TASK_KEY_MAX_CHARS = 80
export const WORK_TASK_TEXT_MAX_CHARS = 280
export const WORK_TASK_BODY_MAX_CHARS = 8_000
export const WORK_COMMENT_BODY_MAX_CHARS = 2_000
export const WORK_ATTACHMENT_NAME_MAX_CHARS = 200
export const WORK_ATTACHMENT_MEDIA_TYPE_MAX_CHARS = 100
export const WORK_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
export const WORK_PAGE_DEFAULT_LIMIT = 50
export const WORK_PAGE_MAX_LIMIT = 100
/** A Task state record section holds at most this many lines. */
export const TASK_STATE_SECTION_MAX_LINES = 8
/** One line of a Task state record, in characters. */
export const TASK_STATE_LINE_MAX_CHARS = 240

export type SpaceTaskStatus = "open" | "deferred" | "done" | "cancelled"
export type SpaceTaskActivity = "idle" | "working" | "needs_you" | "waiting" | "on_hold" | "stopped"
/** What stopped a stopped Task. "restart" — Arden restarted under its run;
 *  "cancelled" — its run was stopped; "stalled" — a run ended without a next
 *  move; "failed" — a run failed. Only a failure is a verdict on the Task. */
export type SpaceTaskStopKind = "restart" | "cancelled" | "stalled" | "failed"
export type SpaceTaskWaitingOn = "you" | "external"
export type SpaceTaskOwner = "worker" | "user" | "external"
/** Where Arden works a Task it owns: in its home chat, as a Goal ran, or in
 *  the background, in a channel of its own. */
type SpaceTaskRunsIn = "chat" | "background"
type SpaceTaskCommentKind = "note" | "ask"

export interface SpaceTaskCaptureInput {
  readonly basis: "explicit" | "long_horizon" | "inferred"
  readonly reason: string
}

type SpaceTaskCapture =
  | SpaceTaskCaptureInput
  | { readonly basis: "unrecorded"; readonly reason: null }

/** Evidence identity is durable even after its source is archived. Null revisions
 * mean the original capture did not record one; they must never be invented. */
export type SpaceTaskSource =
  | {
      readonly kind: "chat"
      readonly session_id: string
      readonly turn_id: string | null
      readonly revision: string | null
    }
  | { readonly kind: "memory"; readonly page_ref: string; readonly revision: string }
  | { readonly kind: "task"; readonly item_id: string; readonly revision: string | null }
  | { readonly kind: "space"; readonly space_id: string; readonly revision: string | null }
  /** A mail or GitHub item routed to the Space (I-23); `revision` is its item id. */
  | { readonly kind: "connection_item"; readonly item_id: string; readonly revision: string }

export interface SpaceTask extends JsonRecord {
  /** Exact recorded state; null until an existing Task receives its baseline. */
  readonly history_revision: string | null
  /** Stable Task reference used by Work deep links and app navigation. */
  readonly item_id: string
  /** Null for a Task with no Space: it belongs to `home_session_id`, or stands alone. */
  readonly space_id: string | null
  /** The chat a Task without a Space belongs to; also the chat an in-chat Task runs in. */
  readonly home_session_id: string | null
  readonly stable_key: string
  readonly text: string
  readonly body: string | null
  readonly status: SpaceTaskStatus
  readonly activity: SpaceTaskActivity
  readonly hold: { readonly question_id: string; readonly acknowledged_at: string } | null
  /** Why a stopped Task stopped, in words; null unless `activity` is "stopped". */
  readonly stop_reason: string | null
  /** Null unless `activity` is "stopped". */
  readonly stop_kind: SpaceTaskStopKind | null
  readonly owner: SpaceTaskOwner
  /** "chat" needs `home_session_id`. */
  readonly runs_in: SpaceTaskRunsIn
  /** A token cap the person asked for, across every run of the Task. */
  readonly token_budget: number | null
  readonly blocked: boolean
  readonly waiting_on: SpaceTaskWaitingOn | null
  readonly due_at: string | null
  readonly next_attempt_at: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly completed_at: string | null
  readonly created_by: string | null
  readonly seq: number | null
  /** How many times the task has been blocked for `last_block_reason`. */
  readonly block_count: number
  readonly sources: ReadonlyArray<SpaceTaskSource>
  readonly capture: SpaceTaskCapture
  /** The lines the owner saved on the Task, oldest first: rules, done-when
   *  criteria and decisions. Empty while it has none. */
  readonly contract: ReadonlyArray<SpaceTaskContractLine>
  /** What its work has done, has running, decided and turned down, and does
   *  next, as the last wake wrote it; null before any wake wrote one. */
  readonly state: SpaceTaskState | null
}

/** Evidence the server resolved for a done-when criterion. */
export type SpaceTaskEvidence =
  | {
      readonly kind: "tool_call"
      readonly tool_call_id: string
      readonly tool_name: string
      readonly exit_code?: number
    }
  | {
      readonly kind: "file"
      readonly path: string
      readonly size: number
      readonly modified_at: string
    }
  | { readonly kind: "attachment"; readonly attachment_id: number; readonly name: string }
  | { readonly kind: "url"; readonly url: string; readonly tool_call_id: string }

/** One saved line of a Task's contract. */
export type SpaceTaskContractLine =
  | { readonly line_id: number; readonly kind: "rule"; readonly text: string }
  | {
      readonly line_id: number
      readonly kind: "criterion"
      readonly text: string
      /** The newest evidence that met it; null while it is not met. */
      readonly met: { readonly evidence: SpaceTaskEvidence; readonly recorded_at: string } | null
    }
  | {
      readonly line_id: number
      readonly kind: "decision"
      readonly text: string
      readonly rejected: string | null
    }

/** A Task's state record, as its last wake wrote it. */
export interface SpaceTaskState {
  readonly done: ReadonlyArray<string>
  readonly in_progress: ReadonlyArray<TaskStateRunning>
  readonly decided: ReadonlyArray<string>
  readonly rejected: ReadonlyArray<TaskStateRejected>
  readonly next: ReadonlyArray<string>
  readonly written_at: string
}

/** Evidence attached to a work event. Arden refs are public refs; providers
 * use their own opaque reference namespace. */
interface ArdenEvidenceSourceRef extends JsonRecord {
  readonly provider: "arden"
  readonly kind: string
  readonly ref: string
  readonly title: string
}

interface ProviderEvidenceSourceRef extends JsonRecord {
  readonly provider: string
  readonly kind: string
  readonly ref: string
  readonly title: string
}

type EvidenceSourceRef = ArdenEvidenceSourceRef | ProviderEvidenceSourceRef

export interface SpaceTaskAttachment extends JsonRecord {
  readonly attachment_id: number
  readonly space_id: string | null
  readonly item_id: string
  readonly name: string
  readonly media_type: string
  readonly size: number
  readonly created_by: string
  readonly created_at: string
}

export interface SpaceTaskComment extends JsonRecord {
  readonly comment_id: number
  readonly space_id: string | null
  readonly item_id: string
  readonly author: string
  readonly body: string
  readonly created_at: string
  readonly kind: SpaceTaskCommentKind
}

export interface SpaceTaskEvent extends JsonRecord {
  readonly event_id: number
  readonly space_id: string | null
  readonly item_id: string | null
  readonly run_ref: string | null
  readonly event_type: string
  readonly content: { readonly kind: "summary" | "result"; readonly text: string }
  readonly source_refs: ReadonlyArray<EvidenceSourceRef>
  readonly created_at: string
}

/** Latest recorded outcome, independent of the current activity or history window. */
export interface SpaceTaskResult extends JsonRecord {
  readonly result_key: string
  /** Authored compact finding; null when only a detailed historical report exists. */
  readonly summary: string | null
  readonly unseen: boolean
  readonly item_id: string
  readonly text: string
  readonly created_at: string
  readonly source:
    | { readonly kind: "event"; readonly event_id: number }
    | { readonly kind: "attempt"; readonly attempt_id: number; readonly run_id: string | null }
}

/** Work embedded in a Space detail response. */
export interface SpaceSnapshot extends JsonRecord {
  readonly results: ReadonlyArray<SpaceTaskResult>
  readonly work_items: ReadonlyArray<SpaceTask>
  readonly events: ReadonlyArray<SpaceTaskEvent>
  readonly comments: ReadonlyArray<SpaceTaskComment>
  readonly attachments: ReadonlyArray<SpaceTaskAttachment>
}

/** The task executor's current or latest run returned with a Work page. */
interface SpaceTaskRun extends JsonRecord {
  readonly attempt_count: number
  readonly item_id: string
  readonly session_id: string
  readonly running: boolean
  readonly run_id: number | null
  /** Journal identity; run_id above identifies the scheduler attempt. */
  readonly chat_run_id: string | null
  readonly started_at: string | null
  readonly ended_at: string | null
  readonly result: string | null
}

/** One bounded page of live work across active Spaces. */
export interface SpaceWorkPage extends JsonRecord {
  readonly items: ReadonlyArray<SpaceTask>
  readonly events: ReadonlyArray<SpaceTaskEvent>
  readonly comments: ReadonlyArray<SpaceTaskComment>
  readonly attachments: ReadonlyArray<SpaceTaskAttachment>
  readonly runs: ReadonlyArray<SpaceTaskRun>
  readonly results: ReadonlyArray<SpaceTaskResult>
  readonly approvals: ReadonlyArray<RunApproval & { readonly item_id: string }>
  readonly next_cursor: string | null
}

export interface SpaceWorkPageOptions {
  readonly spaceId?: string
  readonly sessionId?: string
  /** Restrict Chat Tasks to their first captured source in this physical turn. */
  readonly turnId?: string
  readonly itemId?: string
  readonly limit?: number
  readonly cursor?: string
  /** Include this item in the first page so Inbox deep links always resolve. */
  readonly targetItemId?: string
}

/** A new Task as the owner files it. The server picks its key from `text`
 *  (the first one free where it is filed) and defaults owner to `worker`. */
export interface NewTaskInput {
  readonly text: string
  readonly body?: string | null
  readonly owner?: SpaceTaskOwner
  /** "chat" works it in the chat it is filed from. */
  readonly runs_in?: SpaceTaskRunsIn
  readonly token_budget?: number
}

/** A Task under a key its caller names (a run's own Task, an accepted inference). */
export interface CreateSpaceTaskInput extends NewTaskInput {
  readonly key: string
}

/** A Task without a Space: in the chat `session_id` names, or in none. */
export interface CreateLooseTaskInput extends NewTaskInput {
  readonly session_id?: string
}

/** What the person asks a chat to keep working on (`/goal <text>`): the server
 *  names the Task by its first line, keeps the rest as its details, and works
 *  it in that chat. */
export interface CreateChatTaskInput {
  readonly request: string
  readonly token_budget?: number
}

export interface CreateSpaceTaskCommentInput {
  readonly body: string
}

export interface CreateSpaceTaskAttachmentInput {
  readonly name: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}

/** A saved report or confirmed effect, with the requirement it satisfies. */
type TaskCompletionEvidence =
  | { readonly kind: "attachment"; readonly attachment_id: number; readonly description: string }
  | { readonly kind: "tool"; readonly tool_call_id: string; readonly description: string }

/** A job in progress and the handle that finds it again (a run id, a PID, a URL). */
export interface TaskStateRunning {
  readonly what: string
  readonly handle?: string
}

/** An option the work turned down, and why. */
export interface TaskStateRejected {
  readonly option: string
  readonly why: string
}

/** A wake's change to its Task's state record: each section given replaces
 *  that section; a section left out keeps what the record holds. */
export interface TaskStateRecordPatch {
  readonly done?: ReadonlyArray<string>
  readonly in_progress?: ReadonlyArray<TaskStateRunning>
  readonly decided?: ReadonlyArray<string>
  readonly rejected?: ReadonlyArray<TaskStateRejected>
  readonly next?: ReadonlyArray<string>
}

/** Public update patch. Optimistic concurrency is derived from the current
 * task by `workRequests.update`; consumers never provide the wire field. */
export interface UpdateSpaceTaskPatch {
  /** The Task's state record for its next wake (`TaskStateRecordPatch`); null
   *  clears it. Never a user-facing update or new authority. */
  readonly continuation_context?: TaskStateRecordPatch | null
  /** Final Task result committed with an explicit Done transition. Required for worker completion. */
  readonly completion_result?: string
  readonly completion_evidence?: ReadonlyArray<TaskCompletionEvidence>
  /** Explain failed writes that were recovered or were not required for the outcome. */
  readonly completion_note?: string
  readonly text?: string
  readonly body?: string | null
  readonly status?: SpaceTaskStatus
  readonly owner?: SpaceTaskOwner
  /** "chat" needs the Task's home chat; it must not hold another live in-chat Task. */
  readonly runs_in?: SpaceTaskRunsIn
  /** Null removes the cap. A cap below what is spent leaves the Task waiting on you. */
  readonly token_budget?: number | null
  readonly blocked?: boolean
  readonly waiting_on?: SpaceTaskWaitingOn | null
  /** With blocked: the one concrete thing that unblocks the Task, said as a
   *  direct instruction ("Reconnect Gmail for user@…"). It is the blocked line. */
  readonly block_reason?: string
  readonly due_at?: string | null
  readonly next_attempt_at?: string | null
}

/** Move a Task to a chat: its questions, approvals and results go there. */
export interface MoveTaskToChatInput {
  readonly session_id: string
}

export interface AcknowledgeTaskResultInput {
  readonly result_key: string
}

interface StopSpaceTaskRunResult extends JsonRecord {
  readonly run_id: string
  readonly outcome: "acknowledged" | "finished" | "failed"
}

export interface StopSpaceTaskResponse extends JsonRecord {
  readonly task: SpaceTask
  readonly authority: "revoked"
  readonly state: "acknowledged" | "finished" | "partial"
  readonly runs: ReadonlyArray<StopSpaceTaskRunResult>
}
