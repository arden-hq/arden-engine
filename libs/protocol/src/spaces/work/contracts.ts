import type { RunApproval } from "../../runs/approvals.js"
import type { JsonRecord } from "../../common/json.js"
import type { TokenCap } from "../../settings/limits.js"

export const WORK_TASK_KEY_MAX_CHARS = 80

export const WORK_TASK_TEXT_MAX_CHARS = 280

export const WORK_TASK_BODY_MAX_CHARS = 8_000

export const WORK_COMMENT_BODY_MAX_CHARS = 2_000

export const WORK_ATTACHMENT_NAME_MAX_CHARS = 200

export const WORK_ATTACHMENT_MEDIA_TYPE_MAX_CHARS = 100

export const WORK_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

export const WORK_PAGE_DEFAULT_LIMIT = 50

export const WORK_PAGE_MAX_LIMIT = 100

export const TASK_STATE_SECTION_MAX_LINES = 8

export const TASK_STATE_LINE_MAX_CHARS = 240

export const TASK_STATUS = {
  open: "open",
  deferred: "deferred",
  done: "done",
  cancelled: "cancelled"
} as const

export type SpaceTaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS]

export type UnfinishedTaskStatus = typeof TASK_STATUS.open | typeof TASK_STATUS.deferred

export type FinishedTaskStatus = typeof TASK_STATUS.done | typeof TASK_STATUS.cancelled

const FINISHED_TASK_STATUSES: ReadonlySet<SpaceTaskStatus> = new Set([
  TASK_STATUS.done,
  TASK_STATUS.cancelled
])

export const isFinishedTaskStatus = (status: SpaceTaskStatus): status is FinishedTaskStatus =>
  FINISHED_TASK_STATUSES.has(status)

export const SPACE_TASK_EVENT_TYPE = {
  created: "created",
  updated: "updated",
  scheduled: "scheduled",
  blocked: "blocked",
  unblocked: "unblocked",
  done: "done",
  cancelled: "cancelled",
  reopened: "reopened",
  on_hold: "on_hold",
  block_loop: "block_loop",
  reported: "reported",
  failed: "failed",
  retry_scheduled: "retry_scheduled",
  stalled: "stalled",
  progress: "progress",
  completed: "completed",
  inference_undone: "inference_undone",
  owner_changed: "owner_changed"
} as const

export type SpaceTaskEventType = (typeof SPACE_TASK_EVENT_TYPE)[keyof typeof SPACE_TASK_EVENT_TYPE]

export const SPACE_TASK_CREATED_BY = { user: "user", worker: "worker" } as const

export type SpaceTaskActor = (typeof SPACE_TASK_CREATED_BY)[keyof typeof SPACE_TASK_CREATED_BY]

export type SpaceTaskCreatedBy = SpaceTaskActor | `automation:${string}`

export const TASK_ACTIVITY = {
  idle: "idle",
  working: "working",
  needs_you: "needs_you",
  waiting: "waiting",
  on_hold: "on_hold",
  stopped: "stopped"
} as const

export type SpaceTaskActivity = (typeof TASK_ACTIVITY)[keyof typeof TASK_ACTIVITY]

export const EVIDENCE_KIND = {
  tool_call: "tool_call",
  file: "file",
  attachment: "attachment",
  url: "url"
} as const

export const CONTRACT_LINE = { rule: "rule", criterion: "criterion", decision: "decision" } as const

export const RESULT_SOURCE = { event: "event", attempt: "attempt" } as const

export const EVENT_CONTENT = { summary: "summary", result: "result" } as const

export type SpaceTaskEventContentKind = (typeof EVENT_CONTENT)[keyof typeof EVENT_CONTENT]

export const SPACE_TASK_STOP_KIND = {
  restart: "restart",
  cancelled: "cancelled",
  stalled: "stalled",
  failed: "failed"
} as const

export type SpaceTaskStopKind = (typeof SPACE_TASK_STOP_KIND)[keyof typeof SPACE_TASK_STOP_KIND]

export const SPACE_TASK_WAITING_ON = { you: "you", external: "external" } as const

export type SpaceTaskWaitingOn = (typeof SPACE_TASK_WAITING_ON)[keyof typeof SPACE_TASK_WAITING_ON]

export const SPACE_TASK_OWNER = { worker: "worker", user: "user", external: "external" } as const

export type SpaceTaskOwner = (typeof SPACE_TASK_OWNER)[keyof typeof SPACE_TASK_OWNER]

export const SPACE_TASK_RUNS_IN = { chat: "chat", background: "background" } as const

export type SpaceTaskRunsIn = (typeof SPACE_TASK_RUNS_IN)[keyof typeof SPACE_TASK_RUNS_IN]

export const SPACE_TASK_COMMENT_KIND = { note: "note", ask: "ask" } as const

export type SpaceTaskCommentKind =
  (typeof SPACE_TASK_COMMENT_KIND)[keyof typeof SPACE_TASK_COMMENT_KIND]

export const SPACE_TASK_CAPTURE_BASIS = {
  explicit: "explicit",
  long_horizon: "long_horizon",
  inferred: "inferred",
  unrecorded: "unrecorded"
} as const

export type SpaceTaskCaptureBasis = Exclude<
  (typeof SPACE_TASK_CAPTURE_BASIS)[keyof typeof SPACE_TASK_CAPTURE_BASIS],
  typeof SPACE_TASK_CAPTURE_BASIS.unrecorded
>

export interface SpaceTaskCaptureInput {
  readonly basis: SpaceTaskCaptureBasis
  readonly reason: string
}

type SpaceTaskCapture =
  | SpaceTaskCaptureInput
  | { readonly basis: typeof SPACE_TASK_CAPTURE_BASIS.unrecorded; readonly reason: null }

export const SOURCE_KIND = {
  chat: "chat",
  memory: "memory",
  task: "task",
  space: "space",
  connection_item: "connection_item"
} as const

export const SOURCE_REVISION = { unrecorded: "unrecorded", recorded: "recorded" } as const

export type SourceRevision =
  | { readonly kind: typeof SOURCE_REVISION.unrecorded }
  | { readonly kind: typeof SOURCE_REVISION.recorded; readonly revision: string }

export const SOURCE_TURN = { whole_chat: "whole_chat", turn: "turn" } as const

export type SourceTurn =
  | { readonly kind: typeof SOURCE_TURN.whole_chat }
  | { readonly kind: typeof SOURCE_TURN.turn; readonly turn_id: string }

export type SpaceTaskSource =
  | {
      readonly kind: typeof SOURCE_KIND.chat
      readonly session_id: string
      readonly turn: SourceTurn
      readonly revision: SourceRevision
    }
  | {
      readonly kind: typeof SOURCE_KIND.memory
      readonly page_ref: string
      readonly revision: string
    }
  | {
      readonly kind: typeof SOURCE_KIND.task
      readonly item_id: string
      readonly revision: SourceRevision
    }
  | {
      readonly kind: typeof SOURCE_KIND.space
      readonly space_id: string
      readonly revision: SourceRevision
    }
  | {
      readonly kind: typeof SOURCE_KIND.connection_item
      readonly item_id: string
      readonly revision: string
    }

export const TASK_HISTORY = { unrecorded: "unrecorded", recorded: "recorded" } as const

export const TASK_SPACE = { loose: "loose", space: "space" } as const

export const HOME_CHAT = { none: "none", chat: "chat" } as const

export const TASK_HOLD = { none: "none", held: "held" } as const

export const TASK_STOP = { unrecorded: "unrecorded", recorded: "recorded" } as const

export const TASK_STATE = { unwritten: "unwritten", written: "written" } as const

export const TASK_CREATOR = { unrecorded: "unrecorded", recorded: "recorded" } as const

export const TASK_SEQ = { unnumbered: "unnumbered", numbered: "numbered" } as const

export type TaskSpace =
  | { readonly kind: typeof TASK_SPACE.loose }
  | { readonly kind: typeof TASK_SPACE.space; readonly space_id: string }

export type TaskStop =
  | { readonly kind: typeof TASK_STOP.unrecorded }
  | {
      readonly kind: typeof TASK_STOP.recorded
      readonly stop_kind: SpaceTaskStopKind
      readonly reason: string
    }

export type TaskActivityState =
  | { readonly kind: Exclude<SpaceTaskActivity, typeof TASK_ACTIVITY.stopped> }
  | { readonly kind: typeof TASK_ACTIVITY.stopped; readonly stop: TaskStop }

export type TaskBlockState =
  | { readonly kind: typeof TASK_BLOCK.unblocked }
  | { readonly kind: typeof TASK_BLOCK.blocked; readonly waiting_on: SpaceTaskWaitingOn }

export interface SpaceTaskFields extends JsonRecord {
  readonly history:
    | { readonly kind: typeof TASK_HISTORY.unrecorded }
    | { readonly kind: typeof TASK_HISTORY.recorded; readonly revision: string }
  readonly item_id: string
  readonly space: TaskSpace
  readonly home_chat:
    | { readonly kind: typeof HOME_CHAT.none }
    | { readonly kind: typeof HOME_CHAT.chat; readonly session_id: string }
  readonly stable_key: string
  readonly text: string
  readonly body: TaskBody
  readonly activity: TaskActivityState
  readonly hold:
    | { readonly kind: typeof TASK_HOLD.none }
    | {
        readonly kind: typeof TASK_HOLD.held
        readonly question_id: string
        readonly acknowledged_at: string
      }
  readonly owner: SpaceTaskOwner
  readonly runs_in: SpaceTaskRunsIn
  readonly token_budget: TokenCap
  readonly block: TaskBlockState
  readonly due: TaskDue
  readonly next_attempt: TaskNextAttempt
  readonly created_at: string
  readonly updated_at: string
  readonly created_by:
    | { readonly kind: typeof TASK_CREATOR.unrecorded }
    | { readonly kind: typeof TASK_CREATOR.recorded; readonly by: SpaceTaskCreatedBy }
  readonly seq:
    | { readonly kind: typeof TASK_SEQ.unnumbered }
    | { readonly kind: typeof TASK_SEQ.numbered; readonly seq: number }
  readonly block_count: number
  readonly sources: ReadonlyArray<SpaceTaskSource>
  readonly capture: SpaceTaskCapture
  readonly contract: ReadonlyArray<SpaceTaskContractLine>
  readonly state:
    | { readonly kind: typeof TASK_STATE.unwritten }
    | ({ readonly kind: typeof TASK_STATE.written } & SpaceTaskState)
}

export type SpaceTaskProgress =
  | { readonly status: UnfinishedTaskStatus }
  | { readonly status: FinishedTaskStatus; readonly completed_at: string }

export type SpaceTask = SpaceTaskFields & SpaceTaskProgress

export const TOOL_EXIT = { unknown: "unknown", exited: "exited" } as const

export type SpaceTaskEvidence =
  | {
      readonly kind: typeof EVIDENCE_KIND.tool_call
      readonly tool_call_id: string
      readonly tool_name: string
      readonly exit:
        | { readonly kind: typeof TOOL_EXIT.unknown }
        | { readonly kind: typeof TOOL_EXIT.exited; readonly code: number }
    }
  | {
      readonly kind: typeof EVIDENCE_KIND.file
      readonly path: string
      readonly size: number
      readonly modified_at: string
    }
  | {
      readonly kind: typeof EVIDENCE_KIND.attachment
      readonly attachment_id: number
      readonly name: string
    }
  | { readonly kind: typeof EVIDENCE_KIND.url; readonly url: string; readonly tool_call_id: string }

export const CRITERION_MET = { unmet: "unmet", met: "met" } as const

export const DECISION_REJECTED = { none: "none", rejected: "rejected" } as const

export type SpaceTaskContractLine =
  | { readonly line_id: number; readonly kind: typeof CONTRACT_LINE.rule; readonly text: string }
  | {
      readonly line_id: number
      readonly kind: typeof CONTRACT_LINE.criterion
      readonly text: string
      readonly met:
        | { readonly kind: typeof CRITERION_MET.unmet }
        | {
            readonly kind: typeof CRITERION_MET.met
            readonly evidence: SpaceTaskEvidence
            readonly recorded_at: string
          }
    }
  | {
      readonly line_id: number
      readonly kind: typeof CONTRACT_LINE.decision
      readonly text: string
      readonly rejected:
        | { readonly kind: typeof DECISION_REJECTED.none }
        | { readonly kind: typeof DECISION_REJECTED.rejected; readonly option: string }
    }

export interface SpaceTaskState {
  readonly done: ReadonlyArray<string>
  readonly in_progress: ReadonlyArray<TaskJob>
  readonly decided: ReadonlyArray<string>
  readonly rejected: ReadonlyArray<TaskStateRejected>
  readonly next: ReadonlyArray<string>
  readonly written_at: string
}

export const EVIDENCE_PROVIDER = { arden: "arden" } as const

interface ArdenEvidenceSourceRef extends JsonRecord {
  readonly provider: typeof EVIDENCE_PROVIDER.arden
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
    | { readonly kind: typeof EVENT_ITEM.space_wide }
    | { readonly kind: typeof EVENT_ITEM.item; readonly item_id: string }
  readonly run:
    | { readonly kind: typeof EVENT_RUN.none }
    | { readonly kind: typeof EVENT_RUN.run; readonly run_ref: string }
  readonly event_type: SpaceTaskEventType
  readonly content: { readonly kind: SpaceTaskEventContentKind; readonly text: string }
  readonly source_refs: ReadonlyArray<EvidenceSourceRef>
  readonly created_at: string
}

export const RUN_REF = { none: "none", run: "run" } as const

export type RunRef =
  | { readonly kind: typeof RUN_REF.none }
  | { readonly kind: typeof RUN_REF.run; readonly run_id: string }

export const RESULT_SUMMARY = { none: "none", summary: "summary" } as const

export interface SpaceTaskResult extends JsonRecord {
  readonly result_key: string
  readonly summary:
    | { readonly kind: typeof RESULT_SUMMARY.none }
    | { readonly kind: typeof RESULT_SUMMARY.summary; readonly text: string }
  readonly unseen: boolean
  readonly item_id: string
  readonly text: string
  readonly created_at: string
  readonly source:
    | { readonly kind: typeof RESULT_SOURCE.event; readonly event_id: number }
    | {
        readonly kind: typeof RESULT_SOURCE.attempt
        readonly attempt_id: number
        readonly run: RunRef
      }
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
  | { readonly kind: typeof TASK_RUN.none }
  | {
      readonly kind: typeof TASK_RUN.running
      readonly run_id: number
      readonly chat_run: RunRef
      readonly started_at: string
    }
  | {
      readonly kind: typeof TASK_RUN.ended
      readonly run_id: number
      readonly chat_run: RunRef
      readonly started_at: string
      readonly ended_at: string
      readonly result:
        | { readonly kind: typeof RUN_RESULT.none }
        | { readonly kind: typeof RUN_RESULT.result; readonly text: string }
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
  readonly next:
    | { readonly kind: typeof PAGE_NEXT.end }
    | { readonly kind: typeof PAGE_NEXT.more; readonly cursor: string }
}

export const WORK_PAGE_SCOPE = {
  all: "all",
  space: "space",
  chat: "chat",
  turn: "turn",
  item: "item"
} as const

export type WorkPageScope =
  | { readonly kind: typeof WORK_PAGE_SCOPE.all }
  | { readonly kind: typeof WORK_PAGE_SCOPE.space; readonly space_id: string }
  | { readonly kind: typeof WORK_PAGE_SCOPE.chat; readonly session_id: string }
  | {
      readonly kind: typeof WORK_PAGE_SCOPE.turn
      readonly session_id: string
      readonly turn_id: string
    }
  | { readonly kind: typeof WORK_PAGE_SCOPE.item; readonly item_id: string }

export const WORK_PAGE_START = { first: "first", after: "after", with_item: "with_item" } as const

export type WorkPageStart =
  | { readonly kind: typeof WORK_PAGE_START.first }
  | { readonly kind: typeof WORK_PAGE_START.after; readonly cursor: string }
  | { readonly kind: typeof WORK_PAGE_START.with_item; readonly item_id: string }

export interface SpaceWorkPageOptions {
  readonly scope: WorkPageScope
  readonly start: WorkPageStart
  readonly limit: number
}

export const TASK_BODY = { plain: "plain", detailed: "detailed" } as const

export type TaskBody =
  | { readonly kind: typeof TASK_BODY.plain }
  | { readonly kind: typeof TASK_BODY.detailed; readonly text: string }

export interface TaskStateRejected {
  readonly option: string
  readonly why: string
}

export const JOB_HANDLE = { untracked: "untracked", tracked: "tracked" } as const

export type JobHandle =
  | { readonly kind: typeof JOB_HANDLE.untracked }
  | { readonly kind: typeof JOB_HANDLE.tracked; readonly handle: string }

export interface TaskJob {
  readonly what: string
  readonly handle: JobHandle
}

export const TASK_BLOCK = { unblocked: "unblocked", blocked: "blocked" } as const

export const TASK_DUE = { none: "none", due: "due" } as const

export type TaskDue =
  | { readonly kind: typeof TASK_DUE.none }
  | { readonly kind: typeof TASK_DUE.due; readonly at: string }

export const TASK_NEXT_ATTEMPT = { none: "none", at: "at" } as const

export type TaskNextAttempt =
  | { readonly kind: typeof TASK_NEXT_ATTEMPT.none }
  | { readonly kind: typeof TASK_NEXT_ATTEMPT.at; readonly at: string }
