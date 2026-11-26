import type { JsonRecord } from "../../common/json.js"
import type { TokenCap } from "../../settings/limits.js"
import type {
  SpaceTask,
  SpaceTaskOwner,
  SpaceTaskRunsIn,
  SpaceTaskStatus,
  SpaceTaskWaitingOn,
  TaskBody,
  TaskDue,
  TaskJob,
  TaskNextAttempt,
  TaskStateRejected
} from "./contracts.js"
import { TASK_BLOCK } from "./contracts.js"

export interface NewTaskInput {
  readonly text: string
  readonly body: TaskBody
  readonly owner: SpaceTaskOwner
  readonly runs_in: SpaceTaskRunsIn
  readonly token_budget: TokenCap
}

export const LOOSE_TASK_HOME = { standalone: "standalone", chat: "chat" } as const

export type LooseTaskHome =
  | { readonly kind: typeof LOOSE_TASK_HOME.standalone }
  | { readonly kind: typeof LOOSE_TASK_HOME.chat; readonly session_id: string }

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

export const STATE_SECTION = {
  done: "done",
  in_progress: "in_progress",
  decided: "decided",
  rejected: "rejected",
  next: "next"
} as const

export type TaskStateSection =
  | { readonly section: typeof STATE_SECTION.done; readonly lines: ReadonlyArray<string> }
  | { readonly section: typeof STATE_SECTION.in_progress; readonly jobs: ReadonlyArray<TaskJob> }
  | { readonly section: typeof STATE_SECTION.decided; readonly lines: ReadonlyArray<string> }
  | {
      readonly section: typeof STATE_SECTION.rejected
      readonly options: ReadonlyArray<TaskStateRejected>
    }
  | { readonly section: typeof STATE_SECTION.next; readonly lines: ReadonlyArray<string> }

export const STATE_RECORD_CHANGE = { cleared: "cleared", rewritten: "rewritten" } as const

export type TaskStateRecordChange =
  | { readonly kind: typeof STATE_RECORD_CHANGE.cleared }
  | {
      readonly kind: typeof STATE_RECORD_CHANGE.rewritten
      readonly sections: ReadonlyArray<TaskStateSection>
    }

export const COMPLETION_NOTE = { none: "none", note: "note" } as const

export type CompletionNote =
  | { readonly kind: typeof COMPLETION_NOTE.none }
  | { readonly kind: typeof COMPLETION_NOTE.note; readonly text: string }

export const BLOCK_REASON = { unstated: "unstated", stated: "stated" } as const

export type BlockReason =
  | { readonly kind: typeof BLOCK_REASON.unstated }
  | { readonly kind: typeof BLOCK_REASON.stated; readonly text: string }

export type TaskBlock =
  | { readonly kind: typeof TASK_BLOCK.unblocked }
  | {
      readonly kind: typeof TASK_BLOCK.blocked
      readonly waiting_on: SpaceTaskWaitingOn
      readonly reason: BlockReason
    }

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
  | { readonly kind: typeof TASK_CHANGE.state_record; readonly record: TaskStateRecordChange }
  | { readonly kind: typeof TASK_CHANGE.status; readonly status: SpaceTaskStatus }
  | {
      readonly kind: typeof TASK_CHANGE.complete
      readonly result: string
      readonly evidence: ReadonlyArray<TaskCompletionEvidence>
      readonly note: CompletionNote
    }
  | { readonly kind: typeof TASK_CHANGE.text; readonly text: string }
  | { readonly kind: typeof TASK_CHANGE.body; readonly body: TaskBody }
  | { readonly kind: typeof TASK_CHANGE.owner; readonly owner: SpaceTaskOwner }
  | { readonly kind: typeof TASK_CHANGE.runs_in; readonly runs_in: SpaceTaskRunsIn }
  | { readonly kind: typeof TASK_CHANGE.token_budget; readonly token_budget: TokenCap }
  | { readonly kind: typeof TASK_CHANGE.block; readonly block: TaskBlock }
  | { readonly kind: typeof TASK_CHANGE.due; readonly due: TaskDue }
  | { readonly kind: typeof TASK_CHANGE.next_attempt; readonly next_attempt: TaskNextAttempt }

export interface UpdateSpaceTaskRequest {
  readonly expected_updated_at: string
  readonly changes: ReadonlyArray<TaskChange>
}

export interface MoveTaskToChatInput {
  readonly session_id: string
}

export interface AcknowledgeTaskResultInput {
  readonly result_key: string
}

export const STOP_SPACE_TASK_RUN_OUTCOME = {
  acknowledged: "acknowledged",
  finished: "finished",
  failed: "failed"
} as const

export type StopSpaceTaskRunOutcome =
  (typeof STOP_SPACE_TASK_RUN_OUTCOME)[keyof typeof STOP_SPACE_TASK_RUN_OUTCOME]

interface StopSpaceTaskRunResult extends JsonRecord {
  readonly run_id: string
  readonly outcome: StopSpaceTaskRunOutcome
}

export const STOP_SPACE_TASK_STATE = {
  acknowledged: "acknowledged",
  finished: "finished",
  partial: "partial"
} as const

export type StopSpaceTaskState = (typeof STOP_SPACE_TASK_STATE)[keyof typeof STOP_SPACE_TASK_STATE]

export interface StopSpaceTaskResponse extends JsonRecord {
  readonly task: SpaceTask
  readonly authority: "revoked"
  readonly state: StopSpaceTaskState
  readonly runs: ReadonlyArray<StopSpaceTaskRunResult>
}
