import type { RunApproval } from "../../runs/approvals.js"
import type { JsonRecord } from "../../common/json.js"
import type { TokenCap } from "../../settings/limits.js"

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

export const TASK_STATUS = {
  open: "open",
  deferred: "deferred",
  done: "done",
  cancelled: "cancelled"
} as const

export type SpaceTaskStatus = "open" | "deferred" | "done" | "cancelled"
export const TASK_ACTIVITY = {
  idle: "idle",
  working: "working",
  needs_you: "needs_you",
  waiting: "waiting",
  on_hold: "on_hold",
  stopped: "stopped"
} as const

export type SpaceTaskActivity = "idle" | "working" | "needs_you" | "waiting" | "on_hold" | "stopped"

export const EVIDENCE_KIND = {
  tool_call: "tool_call",
  file: "file",
  attachment: "attachment",
  url: "url"
} as const

export const CONTRACT_LINE = { rule: "rule", criterion: "criterion", decision: "decision" } as const

export const RESULT_SOURCE = { event: "event", attempt: "attempt" } as const

export const EVENT_CONTENT = { summary: "summary", result: "result" } as const
/** What stopped a stopped Task. "restart" — Arden restarted under its run;
 *  "cancelled" — its run was stopped; "stalled" — a run ended without a next
 *  move; "failed" — a run failed. Only a failure is a verdict on the Task. */
export type SpaceTaskStopKind = "restart" | "cancelled" | "stalled" | "failed"
export type SpaceTaskWaitingOn = "you" | "external"
export type SpaceTaskOwner = "worker" | "user" | "external"
/** Where Arden works a Task it owns: in its home chat, as a Goal ran, or in
 *  the background, in a channel of its own. */
export type SpaceTaskRunsIn = "chat" | "background"
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
export const SOURCE_KIND = {
  chat: "chat",
  memory: "memory",
  task: "task",
  space: "space",
  connection_item: "connection_item"
} as const

export const SOURCE_REVISION = { unrecorded: "unrecorded", recorded: "recorded" } as const

export type SourceRevision =
  | { readonly kind: "unrecorded" }
  | { readonly kind: "recorded"; readonly revision: string }

export const SOURCE_TURN = { whole_chat: "whole_chat", turn: "turn" } as const

export type SourceTurn =
  | { readonly kind: "whole_chat" }
  | { readonly kind: "turn"; readonly turn_id: string }

export type SpaceTaskSource =
  | {
      readonly kind: "chat"
      readonly session_id: string
      readonly turn: SourceTurn
      readonly revision: SourceRevision
    }
  | { readonly kind: "memory"; readonly page_ref: string; readonly revision: string }
  | { readonly kind: "task"; readonly item_id: string; readonly revision: SourceRevision }
  | { readonly kind: "space"; readonly space_id: string; readonly revision: SourceRevision }
  | { readonly kind: "connection_item"; readonly item_id: string; readonly revision: string }

export const TASK_HISTORY = { unrecorded: "unrecorded", recorded: "recorded" } as const
export const TASK_SPACE = { loose: "loose", space: "space" } as const
export const HOME_CHAT = { none: "none", chat: "chat" } as const
export const TASK_HOLD = { none: "none", held: "held" } as const
export const TASK_STOP = { unrecorded: "unrecorded", recorded: "recorded" } as const
export const TASK_STATE = { unwritten: "unwritten", written: "written" } as const
export const TASK_CREATOR = { unrecorded: "unrecorded", recorded: "recorded" } as const
export const TASK_SEQ = { unnumbered: "unnumbered", numbered: "numbered" } as const

export type TaskSpace =
  | { readonly kind: "loose" }
  | { readonly kind: "space"; readonly space_id: string }

export type TaskStop =
  | { readonly kind: "unrecorded" }
  | { readonly kind: "recorded"; readonly stop_kind: SpaceTaskStopKind; readonly reason: string }

export type TaskActivityState =
  | { readonly kind: "idle" | "working" | "needs_you" | "waiting" | "on_hold" }
  | { readonly kind: "stopped"; readonly stop: TaskStop }

export type TaskBlockState =
  | { readonly kind: "unblocked" }
  | { readonly kind: "blocked"; readonly waiting_on: SpaceTaskWaitingOn }

export interface SpaceTaskFields extends JsonRecord {
  readonly history:
    | { readonly kind: "unrecorded" }
    | { readonly kind: "recorded"; readonly revision: string }
  readonly item_id: string
  readonly space: TaskSpace
  readonly home_chat:
    | { readonly kind: "none" }
    | { readonly kind: "chat"; readonly session_id: string }
  readonly stable_key: string
  readonly text: string
  readonly body: TaskBody
  readonly activity: TaskActivityState
  readonly hold:
    | { readonly kind: "none" }
    | { readonly kind: "held"; readonly question_id: string; readonly acknowledged_at: string }
  readonly owner: SpaceTaskOwner
  readonly runs_in: SpaceTaskRunsIn
  readonly token_budget: TokenCap
  readonly block: TaskBlockState
  readonly due: TaskDue
  readonly next_attempt: TaskNextAttempt
  readonly created_at: string
  readonly updated_at: string
  readonly created_by:
    | { readonly kind: "unrecorded" }
    | { readonly kind: "recorded"; readonly by: string }
  readonly seq:
    | { readonly kind: "unnumbered" }
    | { readonly kind: "numbered"; readonly seq: number }
  readonly block_count: number
  readonly sources: ReadonlyArray<SpaceTaskSource>
  readonly capture: SpaceTaskCapture
  readonly contract: ReadonlyArray<SpaceTaskContractLine>
  readonly state: { readonly kind: "unwritten" } | ({ readonly kind: "written" } & SpaceTaskState)
}

export type SpaceTaskProgress =
  | { readonly status: "open" | "deferred" }
  | { readonly status: "done" | "cancelled"; readonly completed_at: string }

export type SpaceTask = SpaceTaskFields & SpaceTaskProgress

export const TOOL_EXIT = { unknown: "unknown", exited: "exited" } as const

export type SpaceTaskEvidence =
  | {
      readonly kind: "tool_call"
      readonly tool_call_id: string
      readonly tool_name: string
      readonly exit:
        | { readonly kind: "unknown" }
        | { readonly kind: "exited"; readonly code: number }
    }
  | {
      readonly kind: "file"
      readonly path: string
      readonly size: number
      readonly modified_at: string
    }
  | { readonly kind: "attachment"; readonly attachment_id: number; readonly name: string }
  | { readonly kind: "url"; readonly url: string; readonly tool_call_id: string }

export const CRITERION_MET = { unmet: "unmet", met: "met" } as const
export const DECISION_REJECTED = { none: "none", rejected: "rejected" } as const

export type SpaceTaskContractLine =
  | { readonly line_id: number; readonly kind: "rule"; readonly text: string }
  | {
      readonly line_id: number
      readonly kind: "criterion"
      readonly text: string
      readonly met:
        | { readonly kind: "unmet" }
        | {
            readonly kind: "met"
            readonly evidence: SpaceTaskEvidence
            readonly recorded_at: string
          }
    }
  | {
      readonly line_id: number
      readonly kind: "decision"
      readonly text: string
      readonly rejected:
        | { readonly kind: "none" }
        | { readonly kind: "rejected"; readonly option: string }
    }

export interface SpaceTaskState {
  readonly done: ReadonlyArray<string>
  readonly in_progress: ReadonlyArray<TaskJob>
  readonly decided: ReadonlyArray<string>
  readonly rejected: ReadonlyArray<TaskStateRejected>
  readonly next: ReadonlyArray<string>
  readonly written_at: string
}

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
  readonly space: TaskSpace
  readonly item_id: string
  readonly name: string
  readonly media_type: string
  readonly size: number
  readonly created_by: string
  readonly created_at: string
}

export interface SpaceTaskComment extends JsonRecord {
  readonly comment_id: number
  readonly space: TaskSpace
  readonly item_id: string
  readonly author: string
  readonly body: string
  readonly created_at: string
  readonly kind: SpaceTaskCommentKind
}

export const EVENT_ITEM = { space_wide: "space_wide", item: "item" } as const
export const EVENT_RUN = { none: "none", run: "run" } as const

export interface SpaceTaskEvent extends JsonRecord {
  readonly event_id: number
  readonly space: TaskSpace
  readonly item:
    | { readonly kind: "space_wide" }
    | { readonly kind: "item"; readonly item_id: string }
  readonly run: { readonly kind: "none" } | { readonly kind: "run"; readonly run_ref: string }
  readonly event_type: string
  readonly content: { readonly kind: "summary" | "result"; readonly text: string }
  readonly source_refs: ReadonlyArray<EvidenceSourceRef>
  readonly created_at: string
}

export const RUN_REF = { none: "none", run: "run" } as const

export type RunRef = { readonly kind: "none" } | { readonly kind: "run"; readonly run_id: string }

export const RESULT_SUMMARY = { none: "none", summary: "summary" } as const

export interface SpaceTaskResult extends JsonRecord {
  readonly result_key: string
  readonly summary: { readonly kind: "none" } | { readonly kind: "summary"; readonly text: string }
  readonly unseen: boolean
  readonly item_id: string
  readonly text: string
  readonly created_at: string
  readonly source:
    | { readonly kind: "event"; readonly event_id: number }
    | { readonly kind: "attempt"; readonly attempt_id: number; readonly run: RunRef }
}

export interface SpaceSnapshot extends JsonRecord {
  readonly results: ReadonlyArray<SpaceTaskResult>
  readonly work_items: ReadonlyArray<SpaceTask>
  readonly events: ReadonlyArray<SpaceTaskEvent>
  readonly comments: ReadonlyArray<SpaceTaskComment>
  readonly attachments: ReadonlyArray<SpaceTaskAttachment>
}

export const TASK_RUN = { none: "none", running: "running", ended: "ended" } as const
export const RUN_RESULT = { none: "none", result: "result" } as const

export type TaskRunState =
  | { readonly kind: "none" }
  | {
      readonly kind: "running"
      readonly run_id: number
      readonly chat_run: RunRef
      readonly started_at: string
    }
  | {
      readonly kind: "ended"
      readonly run_id: number
      readonly chat_run: RunRef
      readonly started_at: string
      readonly ended_at: string
      readonly result:
        | { readonly kind: "none" }
        | { readonly kind: "result"; readonly text: string }
    }

export interface SpaceTaskRun extends JsonRecord {
  readonly attempt_count: number
  readonly item_id: string
  readonly session_id: string
  readonly run: TaskRunState
}

export const PAGE_NEXT = { end: "end", more: "more" } as const

export interface SpaceWorkPage extends JsonRecord {
  readonly items: ReadonlyArray<SpaceTask>
  readonly events: ReadonlyArray<SpaceTaskEvent>
  readonly comments: ReadonlyArray<SpaceTaskComment>
  readonly attachments: ReadonlyArray<SpaceTaskAttachment>
  readonly runs: ReadonlyArray<SpaceTaskRun>
  readonly results: ReadonlyArray<SpaceTaskResult>
  readonly approvals: ReadonlyArray<RunApproval & { readonly item_id: string }>
  readonly next: { readonly kind: "end" } | { readonly kind: "more"; readonly cursor: string }
}

export const WORK_PAGE_SCOPE = {
  all: "all",
  space: "space",
  chat: "chat",
  turn: "turn",
  item: "item"
} as const

export type WorkPageScope =
  | { readonly kind: "all" }
  | { readonly kind: "space"; readonly space_id: string }
  | { readonly kind: "chat"; readonly session_id: string }
  | { readonly kind: "turn"; readonly session_id: string; readonly turn_id: string }
  | { readonly kind: "item"; readonly item_id: string }

export const WORK_PAGE_START = { first: "first", after: "after", with_item: "with_item" } as const

export type WorkPageStart =
  | { readonly kind: "first" }
  | { readonly kind: "after"; readonly cursor: string }
  | { readonly kind: "with_item"; readonly item_id: string }

export interface SpaceWorkPageOptions {
  readonly scope: WorkPageScope
  readonly start: WorkPageStart
  readonly limit: number
}

export const TASK_BODY = { plain: "plain", detailed: "detailed" } as const

export type TaskBody =
  | { readonly kind: "plain" }
  | { readonly kind: "detailed"; readonly text: string }

export interface NewTaskInput {
  readonly text: string
  readonly body: TaskBody
  readonly owner: SpaceTaskOwner
  readonly runs_in: SpaceTaskRunsIn
  readonly token_budget: TokenCap
}

export const LOOSE_TASK_HOME = { standalone: "standalone", chat: "chat" } as const

export type LooseTaskHome =
  | { readonly kind: "standalone" }
  | { readonly kind: "chat"; readonly session_id: string }

export interface CreateLooseTaskInput extends NewTaskInput {
  readonly home: LooseTaskHome
}

export interface CreateChatTaskInput {
  readonly request: string
  readonly token_budget: TokenCap
}

export interface CreateSpaceTaskCommentInput {
  readonly body: string
}

export interface CreateSpaceTaskAttachmentInput {
  readonly name: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}

export type TaskCompletionEvidence =
  | { readonly kind: "attachment"; readonly attachment_id: number; readonly description: string }
  | { readonly kind: "tool"; readonly tool_call_id: string; readonly description: string }

export interface TaskStateRejected {
  readonly option: string
  readonly why: string
}

export const JOB_HANDLE = { untracked: "untracked", tracked: "tracked" } as const

export type JobHandle =
  | { readonly kind: "untracked" }
  | { readonly kind: "tracked"; readonly handle: string }

export interface TaskJob {
  readonly what: string
  readonly handle: JobHandle
}

export const STATE_SECTION = {
  done: "done",
  in_progress: "in_progress",
  decided: "decided",
  rejected: "rejected",
  next: "next"
} as const

export type TaskStateSection =
  | { readonly section: "done"; readonly lines: ReadonlyArray<string> }
  | { readonly section: "in_progress"; readonly jobs: ReadonlyArray<TaskJob> }
  | { readonly section: "decided"; readonly lines: ReadonlyArray<string> }
  | { readonly section: "rejected"; readonly options: ReadonlyArray<TaskStateRejected> }
  | { readonly section: "next"; readonly lines: ReadonlyArray<string> }

export const STATE_RECORD_CHANGE = { cleared: "cleared", rewritten: "rewritten" } as const

export type TaskStateRecordChange =
  | { readonly kind: "cleared" }
  | { readonly kind: "rewritten"; readonly sections: ReadonlyArray<TaskStateSection> }

export const COMPLETION_NOTE = { none: "none", note: "note" } as const

export type CompletionNote =
  | { readonly kind: "none" }
  | { readonly kind: "note"; readonly text: string }

export const BLOCK_REASON = { unstated: "unstated", stated: "stated" } as const

export type BlockReason =
  | { readonly kind: "unstated" }
  | { readonly kind: "stated"; readonly text: string }

export const TASK_BLOCK = { unblocked: "unblocked", blocked: "blocked" } as const

export type TaskBlock =
  | { readonly kind: "unblocked" }
  | {
      readonly kind: "blocked"
      readonly waiting_on: SpaceTaskWaitingOn
      readonly reason: BlockReason
    }

export const TASK_DUE = { none: "none", due: "due" } as const

export type TaskDue = { readonly kind: "none" } | { readonly kind: "due"; readonly at: string }

export const TASK_NEXT_ATTEMPT = { none: "none", at: "at" } as const

export type TaskNextAttempt =
  | { readonly kind: "none" }
  | { readonly kind: "at"; readonly at: string }

export const TASK_CHANGE = {
  state_record: "state_record",
  status: "status",
  complete: "complete",
  text: "text",
  body: "body",
  owner: "owner",
  runs_in: "runs_in",
  token_budget: "token_budget",
  block: "block",
  due: "due",
  next_attempt: "next_attempt"
} as const

export type TaskChange =
  | { readonly kind: "state_record"; readonly record: TaskStateRecordChange }
  | { readonly kind: "status"; readonly status: SpaceTaskStatus }
  | {
      readonly kind: "complete"
      readonly result: string
      readonly evidence: ReadonlyArray<TaskCompletionEvidence>
      readonly note: CompletionNote
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "body"; readonly body: TaskBody }
  | { readonly kind: "owner"; readonly owner: SpaceTaskOwner }
  | { readonly kind: "runs_in"; readonly runs_in: SpaceTaskRunsIn }
  | { readonly kind: "token_budget"; readonly token_budget: TokenCap }
  | { readonly kind: "block"; readonly block: TaskBlock }
  | { readonly kind: "due"; readonly due: TaskDue }
  | { readonly kind: "next_attempt"; readonly next_attempt: TaskNextAttempt }

export interface UpdateSpaceTaskRequest {
  readonly expected_updated_at: string
  readonly changes: ReadonlyArray<TaskChange>
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
