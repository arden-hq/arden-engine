import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  withExtras
} from "@arden-hq/protocol/effect/common"
import {
  EvidenceSourceRefSchema,
  SpaceTaskCaptureSchema,
  SpaceTaskStatusSchema,
  TaskOwnerSchema,
  TaskRunsInSchema,
  TaskWaitingOnSchema,
  DueAtSchema,
  SpaceTaskActivitySchema,
  TaskCommentKindSchema,
  TaskApprovalSchema
} from "@arden-hq/protocol/effect/spaces/work"
import {
  EVENT_CONTENT,
  TASK_STATUS,
  WORK_ATTACHMENT_MAX_BYTES
} from "@arden-hq/protocol/spaces/work"
import { WikiPageIdSchema } from "@arden-hq/protocol/effect/wiki"
import { ChatActionRetirementSourceSchema } from "@arden-hq/protocol/effect/proposals"
import { Schema } from "effect"

const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))
const WorkTimestampSchema = IsoDateTimeStringSchema
const NullableWorkTimestampSchema = Schema.NullOr(WorkTimestampSchema)
const sourceIdentitySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const boundedTrimmed = (maximum: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

const sourceRevisionSchema = Schema.NullOr(sourceIdentitySchema)
export const TaskSourceRecordSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat"),
    session_id: sourceIdentitySchema,
    turn_id: Schema.NullOr(sourceIdentitySchema),
    revision: sourceRevisionSchema
  }),
  Schema.Struct({
    kind: Schema.Literal("memory"),
    page_ref: WikiPageIdSchema,
    revision: sourceIdentitySchema
  }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    item_id: sourceIdentitySchema,
    revision: sourceRevisionSchema
  }),
  Schema.Struct({
    kind: Schema.Literal("space"),
    space_id: sourceIdentitySchema,
    revision: sourceRevisionSchema
  }),
  Schema.Struct({
    kind: Schema.Literal("connection_item"),
    item_id: sourceIdentitySchema,
    revision: sourceIdentitySchema
  })
])

const TaskEvidenceRecordSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool_call"),
    tool_call_id: NonEmptyStringSchema,
    tool_name: NonEmptyStringSchema,
    exit_code: Schema.optionalKey(Schema.Int)
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: NonEmptyStringSchema,
    size: NonNegativeIntSchema,
    modified_at: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    attachment_id: PositiveIntSchema,
    name: NonEmptyStringSchema
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: NonEmptyStringSchema,
    tool_call_id: NonEmptyStringSchema
  })
])

const TaskContractLineRecordSchema = Schema.Union([
  Schema.Struct({
    line_id: PositiveIntSchema,
    kind: Schema.Literal("rule"),
    text: NonEmptyStringSchema
  }),
  Schema.Struct({
    line_id: PositiveIntSchema,
    kind: Schema.Literal("criterion"),
    text: NonEmptyStringSchema,
    met: Schema.NullOr(
      Schema.Struct({ evidence: TaskEvidenceRecordSchema, recorded_at: Schema.String })
    )
  }),
  Schema.Struct({
    line_id: PositiveIntSchema,
    kind: Schema.Literal("decision"),
    text: NonEmptyStringSchema,
    rejected: Schema.NullOr(NonEmptyStringSchema)
  })
])

const TaskStateRecordSchema = Schema.Struct({
  done: Schema.Array(Schema.String),
  in_progress: Schema.Array(
    Schema.Struct({ what: Schema.String, handle: Schema.optionalKey(Schema.String) })
  ),
  decided: Schema.Array(Schema.String),
  rejected: Schema.Array(Schema.Struct({ option: Schema.String, why: Schema.String })),
  next: Schema.Array(Schema.String),
  written_at: Schema.String
})

const taskRecordFields = {
  history_revision: Schema.NullOr(NonEmptyStringSchema),
  item_id: NonEmptyStringSchema,
  space_id: Schema.NullOr(NonEmptyStringSchema),
  home_session_id: Schema.NullOr(NonEmptyStringSchema),
  stable_key: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  body: Schema.NullOr(Schema.String),
  status: SpaceTaskStatusSchema,
  activity: SpaceTaskActivitySchema,
  hold: Schema.NullOr(
    Schema.Struct({ question_id: NonEmptyStringSchema, acknowledged_at: WorkTimestampSchema })
  ),
  stop_reason: Schema.NullOr(Schema.String),
  stop_kind: Schema.NullOr(Schema.Literals(["restart", "cancelled", "stalled", "failed"])),
  owner: TaskOwnerSchema,
  runs_in: TaskRunsInSchema,
  token_budget: Schema.NullOr(PositiveIntSchema),
  blocked: Schema.Boolean,
  waiting_on: Schema.NullOr(TaskWaitingOnSchema),
  due_at: Schema.NullOr(DueAtSchema),
  next_attempt_at: NullableWorkTimestampSchema,
  created_at: WorkTimestampSchema,
  updated_at: WorkTimestampSchema,
  completed_at: NullableWorkTimestampSchema,
  created_by: Schema.NullOr(Schema.String),
  seq: Schema.NullOr(NonNegativeIntSchema),
  block_count: NonNegativeIntSchema,
  sources: Schema.Array(TaskSourceRecordSchema),
  capture: SpaceTaskCaptureSchema,
  contract: Schema.Array(TaskContractLineRecordSchema),
  state: Schema.NullOr(TaskStateRecordSchema)
} as const

const waitingOnIssue = (task: { readonly blocked: boolean; readonly waiting_on: unknown }) => {
  if (task.blocked) {
    return task.waiting_on !== null
      ? undefined
      : { path: ["waiting_on"], issue: "is required for a blocked task" }
  }
  return task.waiting_on === null
    ? undefined
    : { path: ["waiting_on"], issue: "must be null for an unblocked task" }
}

export const TaskRecordSchema = withExtras(taskRecordFields).check(
  Schema.makeFilter((task) => waitingOnIssue(task)),
  Schema.makeFilter((task) => {
    const terminal = task.status === TASK_STATUS.done || task.status === TASK_STATUS.cancelled
    return terminal === (task.completed_at !== null)
      ? undefined
      : {
          path: ["completed_at"],
          issue: terminal
            ? "is required for a completed or cancelled task"
            : "must be null for an active task"
        }
  })
)

export const TaskAttachmentRecordSchema = withExtras({
  attachment_id: PositiveIntSchema,
  space_id: Schema.NullOr(NonEmptyStringSchema),
  item_id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  media_type: NonEmptyStringSchema,
  size: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(WORK_ATTACHMENT_MAX_BYTES)),
  created_by: NonEmptyStringSchema,
  created_at: WorkTimestampSchema
}).check(
  Schema.makeFilter((attachment) =>
    Object.hasOwn(attachment, "path")
      ? { path: ["path"], issue: "is not part of the Work attachment API" }
      : undefined
  )
)

export const TaskCommentRecordSchema = withExtras({
  comment_id: PositiveIntSchema,
  space_id: Schema.NullOr(NonEmptyStringSchema),
  item_id: NonEmptyStringSchema,
  author: NonEmptyStringSchema,
  body: NonEmptyStringSchema,
  created_at: WorkTimestampSchema,
  kind: TaskCommentKindSchema
})

export const TaskEventRecordSchema = withExtras({
  event_id: PositiveIntSchema,
  space_id: Schema.NullOr(NonEmptyStringSchema),
  item_id: Schema.NullOr(Schema.String),
  run_ref: Schema.NullOr(Schema.String),
  event_type: NonEmptyStringSchema,
  content: Schema.Struct({
    kind: Schema.Literals(["summary", "result"]),
    text: NonEmptyStringSchema
  }),
  source_refs: Schema.Array(EvidenceSourceRefSchema),
  created_at: WorkTimestampSchema
}).check(
  Schema.makeFilter((event) =>
    event.content.kind === EVENT_CONTENT.result && event.event_type !== TASK_STATUS.done
      ? { path: ["content"], issue: "a completion result requires a Done event" }
      : undefined
  )
)

export const TaskResultRecordSchema = withExtras({
  result_key: NonEmptyStringSchema,
  summary: Schema.NullOr(boundedTrimmed(500)),
  unseen: Schema.Boolean,
  item_id: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  created_at: WorkTimestampSchema,
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("event"), event_id: PositiveIntSchema }),
    Schema.Struct({
      kind: Schema.Literal("attempt"),
      attempt_id: PositiveIntSchema,
      run_id: Schema.NullOr(NonEmptyStringSchema)
    })
  ])
})

export const SnapshotRecordSchema = withExtras({
  results: Schema.Array(TaskResultRecordSchema),
  work_items: Schema.Array(TaskRecordSchema),
  events: Schema.Array(TaskEventRecordSchema),
  comments: Schema.Array(TaskCommentRecordSchema),
  attachments: Schema.Array(TaskAttachmentRecordSchema)
})

const TaskRunRecordSchema = withExtras({
  attempt_count: NonNegativeIntSchema,
  item_id: NonEmptyStringSchema,
  session_id: NonEmptyStringSchema,
  running: Schema.Boolean,
  run_id: Schema.NullOr(PositiveIntSchema),
  chat_run_id: Schema.NullOr(NonEmptyStringSchema),
  started_at: NullableWorkTimestampSchema,
  ended_at: NullableWorkTimestampSchema,
  result: Schema.NullOr(Schema.String)
}).check(
  Schema.makeFilter((run) => {
    if (run.run_id === null) {
      return run.started_at === null && run.ended_at === null && run.result === null && !run.running
        ? undefined
        : { path: ["run_id"], issue: "must identify a run when run data is present" }
    }
    if (run.started_at === null) {
      return { path: ["started_at"], issue: "is required for an identified run" }
    }
    if (run.running && run.ended_at !== null) {
      return { path: ["ended_at"], issue: "must be null while the run is active" }
    }
    if (!run.running && run.ended_at === null) {
      return { path: ["ended_at"], issue: "is required after the run settles" }
    }
    return undefined
  })
)

const StopSpaceTaskRunResultSchema = Schema.Struct({
  run_id: NonEmptyStringSchema,
  outcome: Schema.Literals(["acknowledged", "finished", "failed"] as const)
})
export const StopTaskRecordSchema = withExtras({
  task: TaskRecordSchema,
  authority: Schema.Literal("revoked"),
  state: Schema.Literals(["acknowledged", "finished", "partial"] as const),
  runs: Schema.Array(StopSpaceTaskRunResultSchema)
})

export const WorkPageRecordSchema = withExtras({
  items: Schema.Array(TaskRecordSchema),
  events: Schema.Array(TaskEventRecordSchema),
  comments: Schema.Array(TaskCommentRecordSchema),
  attachments: Schema.Array(TaskAttachmentRecordSchema),
  runs: Schema.Array(TaskRunRecordSchema),
  results: Schema.Array(TaskResultRecordSchema),
  approvals: Schema.Array(TaskApprovalSchema),
  next_cursor: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)))
})

export type TaskSourceRecord = typeof TaskSourceRecordSchema.Type
export type TaskRecord = typeof TaskRecordSchema.Type
export type TaskAttachmentRecord = typeof TaskAttachmentRecordSchema.Type
export type TaskCommentRecord = typeof TaskCommentRecordSchema.Type
export type TaskEventRecord = typeof TaskEventRecordSchema.Type
export type TaskResultRecord = typeof TaskResultRecordSchema.Type
export type SnapshotRecord = typeof SnapshotRecordSchema.Type
export type TaskRunRecord = typeof TaskRunRecordSchema.Type
export type WorkPageRecord = typeof WorkPageRecordSchema.Type
export type StopTaskRecord = typeof StopTaskRecordSchema.Type
type TaskStateRecord = typeof TaskStateRecordSchema.Type
export type TaskContractLineRecord = typeof TaskContractLineRecordSchema.Type
export type TaskEvidenceRecord = typeof TaskEvidenceRecordSchema.Type
export type TaskJobRecord = TaskStateRecord["in_progress"][number]

export const RetirementSourceRecordSchema = Schema.Union([
  TaskSourceRecordSchema,
  ChatActionRetirementSourceSchema
])
export type RetirementSourceRecord = typeof RetirementSourceRecordSchema.Type
