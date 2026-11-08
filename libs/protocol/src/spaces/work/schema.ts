import { checkRunApprovalConnection, runApprovalFields } from "../../runs/approval-schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import { WikiPageIdSchema } from "../../wiki/schema/shared.js"
import { Effect, Schema, SchemaTransformation } from "effect"
import type {
  SpaceTask,
  SpaceTaskActivity,
  SpaceTaskStatus,
  SpaceTaskComment,
  SpaceTaskAttachment,
  SpaceWorkPage,
  StopSpaceTaskResponse
} from "./contracts.js"
import {
  IsoDateTimeStringSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../../common/schema.js"
import {
  WORK_ATTACHMENT_MAX_BYTES,
  WORK_ATTACHMENT_MEDIA_TYPE_MAX_CHARS,
  WORK_ATTACHMENT_NAME_MAX_CHARS,
  WORK_COMMENT_BODY_MAX_CHARS,
  WORK_PAGE_MAX_LIMIT,
  WORK_TASK_BODY_MAX_CHARS,
  WORK_TASK_KEY_MAX_CHARS,
  WORK_TASK_TEXT_MAX_CHARS,
  TASK_STATE_LINE_MAX_CHARS,
  TASK_STATE_SECTION_MAX_LINES
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))
const TrimmedTextSchema = Schema.Trim.check(Schema.isMinLength(1))
const WorkTimestampSchema = IsoDateTimeStringSchema
const NullableWorkTimestampSchema = Schema.NullOr(WorkTimestampSchema)
/** `due_at` is display-only in the live server and historically accepts
 * free-form text; `next_attempt_at` is the scheduler-owned parsed field. */
const DueAtSchema = Schema.String.check(Schema.isMaxLength(512))

const boundedTrimmed = (maximum: number) => TrimmedTextSchema.check(Schema.isMaxLength(maximum))

const noLineBreaks = Schema.makeFilter((value: string) =>
  value.includes("\r") || value.includes("\n") ? "must be a single line" : undefined
)

export const WorkTaskKeySchema = boundedTrimmed(WORK_TASK_KEY_MAX_CHARS).check(
  Schema.makeFilter((value) =>
    /^[a-z0-9][a-z0-9_-]*$/.test(value)
      ? undefined
      : "must start with a lowercase letter or number and contain only lowercase letters, numbers, '-' or '_'"
  )
)

const taskTextInputSchema = boundedTrimmed(WORK_TASK_TEXT_MAX_CHARS).check(noLineBreaks)
const taskBodyInputSchema = Schema.String.check(Schema.isMaxLength(WORK_TASK_BODY_MAX_CHARS))
const commentBodyInputSchema = boundedTrimmed(WORK_COMMENT_BODY_MAX_CHARS)
export const SpaceTaskStatusSchema = Schema.Literals([
  "open",
  "deferred",
  "done",
  "cancelled"
] as const)
const SpaceTaskActivitySchema = Schema.Literals([
  "idle",
  "working",
  "needs_you",
  "waiting",
  "on_hold",
  "stopped"
] as const)
const taskWaitingOnSchema = Schema.Literals(["you", "external"] as const)
const taskOwnerSchema = Schema.Literals(["worker", "user", "external"] as const)
const taskRunsInSchema = Schema.Literals(["chat", "background"] as const)
const taskCommentKindSchema = Schema.Literals(["note", "ask"] as const)

const mediaTypeInputSchema = boundedTrimmed(WORK_ATTACHMENT_MEDIA_TYPE_MAX_CHARS).check(
  Schema.makeFilter((value) =>
    /^[a-z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value)
      ? undefined
      : "must be a valid media type"
  )
)

const attachmentBytesSchema = Schema.Uint8Array.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(WORK_ATTACHMENT_MAX_BYTES)
)

const attachmentBase64Schema = Schema.toEncoded(Schema.Uint8ArrayFromBase64).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(Math.ceil(WORK_ATTACHMENT_MAX_BYTES / 3) * 4)
)

const attachmentBytesFromBase64Schema = attachmentBase64Schema.pipe(
  Schema.decodeTo(attachmentBytesSchema, SchemaTransformation.uint8ArrayFromBase64String)
)

const evidenceKindSchema = boundedTrimmed(64).check(
  Schema.makeFilter((value) =>
    /^[a-z0-9][a-z0-9_-]*$/.test(value) ? undefined : "must be a lowercase provider kind"
  )
)
const evidenceRefSchema = boundedTrimmed(4096).check(noLineBreaks)
const evidenceTitleSchema = boundedTrimmed(256).check(noLineBreaks)
const ardenPublicRefSchema = evidenceRefSchema.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*~[a-z0-9]{6}$/)
)

const ardenEvidenceSourceRefSchema = withExtras({
  provider: Schema.Literal("arden"),
  kind: evidenceKindSchema,
  ref: ardenPublicRefSchema,
  title: evidenceTitleSchema
})

const providerEvidenceSourceRefSchema = withExtras({
  provider: boundedTrimmed(64).check(
    Schema.makeFilter((value) =>
      /^[a-z0-9][a-z0-9_-]*$/.test(value) && value !== "arden"
        ? undefined
        : "must be a lowercase non-Arden provider"
    )
  ),
  kind: evidenceKindSchema,
  ref: evidenceRefSchema,
  title: evidenceTitleSchema
})

export const EvidenceSourceRefSchema = Schema.Union([
  ardenEvidenceSourceRefSchema,
  providerEvidenceSourceRefSchema
])

const sourceIdentitySchema = boundedTrimmed(4096)
export const SpaceTaskCaptureInputSchema = Schema.Struct({
  basis: Schema.Literals(["explicit", "long_horizon", "inferred"]).annotate({
    description:
      "explicit: requested tracking; long_horizon: ongoing ownership or later follow-up; inferred: agent capture under the Space inference policy."
  }),
  reason: boundedTrimmed(2000).pipe(
    Schema.annotateEncoded({
      description:
        "One concrete evidence-based sentence explaining why this outcome needs tracking."
    })
  )
})
export const SpaceTaskCaptureSchema = Schema.Union([
  SpaceTaskCaptureInputSchema,
  Schema.Struct({ basis: Schema.Literal("unrecorded"), reason: Schema.Null })
])
const sourceRevisionSchema = Schema.NullOr(sourceIdentitySchema)
export const SpaceTaskSourceSchema = Schema.Union([
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

const SpaceTaskEvidenceSchema = Schema.Union([
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

const SpaceTaskContractLineSchema = Schema.Union([
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
      Schema.Struct({ evidence: SpaceTaskEvidenceSchema, recorded_at: Schema.String })
    )
  }),
  Schema.Struct({
    line_id: PositiveIntSchema,
    kind: Schema.Literal("decision"),
    text: NonEmptyStringSchema,
    rejected: Schema.NullOr(NonEmptyStringSchema)
  })
])

const SpaceTaskStateSchema = Schema.Struct({
  done: Schema.Array(Schema.String),
  in_progress: Schema.Array(
    Schema.Struct({ what: Schema.String, handle: Schema.optionalKey(Schema.String) })
  ),
  decided: Schema.Array(Schema.String),
  rejected: Schema.Array(Schema.Struct({ option: Schema.String, why: Schema.String })),
  next: Schema.Array(Schema.String),
  written_at: Schema.String
})

const spaceTaskFields = {
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
  owner: taskOwnerSchema,
  runs_in: taskRunsInSchema,
  token_budget: Schema.NullOr(PositiveIntSchema),
  blocked: Schema.Boolean,
  waiting_on: Schema.NullOr(taskWaitingOnSchema),
  due_at: Schema.NullOr(DueAtSchema),
  next_attempt_at: NullableWorkTimestampSchema,
  created_at: WorkTimestampSchema,
  updated_at: WorkTimestampSchema,
  completed_at: NullableWorkTimestampSchema,
  created_by: Schema.NullOr(Schema.String),
  seq: Schema.NullOr(NonNegativeIntSchema),
  block_count: NonNegativeIntSchema,
  sources: Schema.Array(SpaceTaskSourceSchema),
  capture: SpaceTaskCaptureSchema,
  contract: Schema.Array(SpaceTaskContractLineSchema),
  state: Schema.NullOr(SpaceTaskStateSchema)
} as const

/** A blocked task names who it waits on; an unblocked one names nobody. */
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

/** Stored task invariants are also the public contract: the block owner is
 * never present on an unblocked task, and terminal tasks have a completion
 * timestamp while live tasks do not. */
export const SpaceTaskSchema: Schema.Codec<SpaceTask> = withExtras(spaceTaskFields).check(
  Schema.makeFilter((task) => waitingOnIssue(task)),
  Schema.makeFilter((task) => {
    const terminal = task.status === "done" || task.status === "cancelled"
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

export const SpaceTaskAttachmentSchema: Schema.Codec<SpaceTaskAttachment> = withExtras({
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

export const SpaceTaskCommentSchema: Schema.Codec<SpaceTaskComment> = withExtras({
  comment_id: PositiveIntSchema,
  space_id: Schema.NullOr(NonEmptyStringSchema),
  item_id: NonEmptyStringSchema,
  author: NonEmptyStringSchema,
  body: NonEmptyStringSchema,
  created_at: WorkTimestampSchema,
  kind: taskCommentKindSchema
})

export const SpaceTaskEventSchema = withExtras({
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
    event.content.kind === "result" && event.event_type !== "done"
      ? { path: ["content"], issue: "a completion result requires a Done event" }
      : undefined
  )
)

export const SpaceTaskResultSchema = withExtras({
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

export const SpaceSnapshotSchema = withExtras({
  results: Schema.Array(SpaceTaskResultSchema),
  work_items: Schema.Array(SpaceTaskSchema),
  events: Schema.Array(SpaceTaskEventSchema),
  comments: Schema.Array(SpaceTaskCommentSchema),
  attachments: Schema.Array(SpaceTaskAttachmentSchema)
})

const SpaceTaskRunSchema = withExtras({
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

export const MoveTaskToChatInputSchema = Schema.Struct({ session_id: NonEmptyStringSchema })
export const AcknowledgeTaskResultInputSchema = Schema.Struct({ result_key: NonEmptyStringSchema })
export const StopSpaceTaskInputSchema = Schema.Struct({ expected_updated_at: WorkTimestampSchema })
const StopSpaceTaskRunResultSchema = Schema.Struct({
  run_id: NonEmptyStringSchema,
  outcome: Schema.Literals(["acknowledged", "finished", "failed"] as const)
})
export const StopSpaceTaskResponseSchema: Schema.Codec<StopSpaceTaskResponse> = withExtras({
  task: SpaceTaskSchema,
  authority: Schema.Literal("revoked"),
  state: Schema.Literals(["acknowledged", "finished", "partial"] as const),
  runs: Schema.Array(StopSpaceTaskRunResultSchema)
})

/** @internal Compile-time check that the schema and the type agree. */
export type StopSpaceTaskResponseAgrees = Assert<
  Agrees<(typeof StopSpaceTaskResponseSchema)["Type"], StopSpaceTaskResponse>
>
export const WorkOkResponseSchema = Schema.Struct({ ok: Schema.Literal(true) })
export const encodeMoveTaskToChatEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(MoveTaskToChatInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
export const encodeAcknowledgeTaskResultEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(AcknowledgeTaskResultInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const SpaceWorkPageSchema: Schema.Codec<SpaceWorkPage> = withExtras({
  items: Schema.Array(SpaceTaskSchema),
  events: Schema.Array(SpaceTaskEventSchema),
  comments: Schema.Array(SpaceTaskCommentSchema),
  attachments: Schema.Array(SpaceTaskAttachmentSchema),
  runs: Schema.Array(SpaceTaskRunSchema),
  results: Schema.Array(SpaceTaskResultSchema),
  approvals: Schema.Array(
    withExtras({
      ...runApprovalFields,
      item_id: Schema.String
    }).check(Schema.makeFilter(checkRunApprovalConnection))
  ),
  next_cursor: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)))
})

export const SpaceWorkPageOptionsSchema = Schema.Struct({
  spaceId: Schema.optionalKey(NonEmptyStringSchema),
  sessionId: Schema.optionalKey(NonEmptyStringSchema),
  turnId: Schema.optionalKey(NonEmptyStringSchema),
  itemId: Schema.optionalKey(NonEmptyStringSchema),
  limit: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORK_PAGE_MAX_LIMIT)
    )
  ),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))),
  targetItemId: Schema.optionalKey(NonEmptyStringSchema)
}).check(
  Schema.makeFilter((options) =>
    options.turnId !== undefined && options.sessionId === undefined
      ? { path: ["turnId"], issue: "requires a Chat session" }
      : undefined
  ),
  Schema.makeFilter((options) =>
    options.cursor !== undefined && options.targetItemId !== undefined
      ? { path: ["targetItemId"], issue: "cannot be combined with a page cursor" }
      : undefined
  )
)

export const SpaceWorkPageQuerySchema = Schema.Struct({
  space_id: Schema.optionalKey(NonEmptyStringSchema),
  session_id: Schema.optionalKey(NonEmptyStringSchema),
  turn_id: Schema.optionalKey(NonEmptyStringSchema),
  item_id: Schema.optionalKey(NonEmptyStringSchema),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORK_PAGE_MAX_LIMIT)
    )
  ),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))),
  target_item_id: Schema.optionalKey(NonEmptyStringSchema)
}).check(
  Schema.makeFilter((query) =>
    query.turn_id !== undefined && query.session_id === undefined
      ? { path: ["turn_id"], issue: "requires a Chat session" }
      : undefined
  ),
  Schema.makeFilter((query) =>
    query.cursor !== undefined && query.target_item_id !== undefined
      ? { path: ["target_item_id"], issue: "cannot be combined with a page cursor" }
      : undefined
  )
)

/** A new Task as the owner files it: the server picks its key from `text`. */
const newTaskInputFields = {
  text: taskTextInputSchema,
  body: Schema.optionalKey(Schema.NullOr(taskBodyInputSchema)),
  owner: Schema.optionalKey(taskOwnerSchema),
  runs_in: Schema.optionalKey(taskRunsInSchema),
  token_budget: Schema.optionalKey(PositiveIntSchema)
} as const

export const NewTaskInputSchema = Schema.Struct(newTaskInputFields)

/** A Task under a key its caller names (a run's own Task, an accepted inference). */
export const CreateSpaceTaskInputSchema = Schema.Struct({
  key: WorkTaskKeySchema,
  ...newTaskInputFields
})

export const CreateChatTaskInputSchema = Schema.Struct({
  request: boundedTrimmed(WORK_TASK_BODY_MAX_CHARS),
  token_budget: Schema.optionalKey(PositiveIntSchema)
})

export const encodeCreateChatTaskRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateChatTaskInputSchema)(value, strict).pipe(
    Effect.map((input) => JSON.stringify(input))
  )

/** A Task without a Space: in the chat `session_id` names, or in none. */
export const CreateLooseTaskInputSchema = Schema.Struct({
  ...newTaskInputFields,
  session_id: Schema.optionalKey(Schema.NonEmptyString)
})

export const CreateSpaceTaskCommentInputSchema = Schema.Struct({
  body: commentBodyInputSchema
})

export const CreateSpaceTaskAttachmentInputSchema = Schema.Struct({
  name: boundedTrimmed(WORK_ATTACHMENT_NAME_MAX_CHARS),
  media_type: mediaTypeInputSchema,
  data: attachmentBytesFromBase64Schema
})

const CreateSpaceTaskAttachmentConsumerInputSchema = Schema.Struct({
  name: boundedTrimmed(WORK_ATTACHMENT_NAME_MAX_CHARS),
  mediaType: mediaTypeInputSchema,
  bytes: attachmentBytesSchema
})

export type CreateSpaceTaskAttachmentRequest = typeof CreateSpaceTaskAttachmentInputSchema.Type

const stateLineSchema = boundedTrimmed(TASK_STATE_LINE_MAX_CHARS)
const stateSection = <S extends Schema.Top>(line: S) =>
  Schema.optionalKey(Schema.Array(line).check(Schema.isMaxLength(TASK_STATE_SECTION_MAX_LINES)))

const TaskStateRecordPatchSchema = Schema.Struct({
  done: stateSection(stateLineSchema),
  in_progress: stateSection(
    Schema.Struct({ what: stateLineSchema, handle: Schema.optionalKey(stateLineSchema) })
  ),
  decided: stateSection(stateLineSchema),
  rejected: stateSection(Schema.Struct({ option: stateLineSchema, why: stateLineSchema })),
  next: stateSection(stateLineSchema)
}).check(
  Schema.makeFilter((patch) =>
    Object.keys(patch).length > 0 ? undefined : "a state record change needs at least one section"
  )
)

const updateSpaceTaskPatchFields = {
  continuation_context: Schema.optionalKey(Schema.NullOr(TaskStateRecordPatchSchema)),
  completion_result: Schema.optionalKey(boundedTrimmed(500)),
  completion_evidence: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("attachment").annotate({
            description: "Evidence saved as a Task attachment."
          }),
          attachment_id: PositiveIntSchema.annotate({
            description: "Exact ID of the saved Task attachment."
          }),
          description: boundedTrimmed(500).pipe(
            Schema.annotateEncoded({ description: "The requirement this saved result fulfills." })
          )
        }),
        Schema.Struct({
          kind: Schema.Literal("tool").annotate({
            description: "Evidence from a confirmed write in the current Run."
          }),
          tool_call_id: boundedTrimmed(512).pipe(
            Schema.annotateEncoded({
              description: "Exact tool_call_id of the successful current-run write."
            })
          ),
          description: boundedTrimmed(500).pipe(
            Schema.annotateEncoded({
              description: "The requirement this confirmed write fulfills."
            })
          )
        })
      ])
    ).check(Schema.isMinLength(1), Schema.isMaxLength(20))
  ),
  completion_note: Schema.optionalKey(boundedTrimmed(1_000)),
  text: Schema.optionalKey(taskTextInputSchema),
  body: Schema.optionalKey(Schema.NullOr(taskBodyInputSchema)),
  status: Schema.optionalKey(SpaceTaskStatusSchema),
  owner: Schema.optionalKey(taskOwnerSchema),
  runs_in: Schema.optionalKey(taskRunsInSchema),
  token_budget: Schema.optionalKey(Schema.NullOr(PositiveIntSchema)),
  blocked: Schema.optionalKey(Schema.Boolean),
  waiting_on: Schema.optionalKey(Schema.NullOr(taskWaitingOnSchema)),
  block_reason: Schema.optionalKey(boundedTrimmed(200)),
  due_at: Schema.optionalKey(Schema.NullOr(DueAtSchema)),
  next_attempt_at: Schema.optionalKey(NullableWorkTimestampSchema)
} as const

export const UpdateSpaceTaskPatchSchema = Schema.Struct(updateSpaceTaskPatchFields).check(
  Schema.makeFilter((patch) =>
    Object.keys(patch).length > 0 ? undefined : "an update requires at least one field"
  ),
  Schema.makeFilter((patch) =>
    patch.completion_result !== undefined && patch.status !== "done"
      ? { path: ["completion_result"], issue: "requires an explicit Done transition" }
      : undefined
  ),
  Schema.makeFilter((patch) =>
    (patch.completion_evidence !== undefined || patch.completion_note !== undefined) &&
    (patch.status !== "done" || patch.completion_result === undefined)
      ? "Completion evidence and notes require a completion_result and explicit Done transition"
      : undefined
  )
)

const SpaceTaskBlockStateSchema = Schema.Struct({
  blocked: Schema.Boolean,
  waiting_on: Schema.NullOr(taskWaitingOnSchema)
}).check(Schema.makeFilter((state) => waitingOnIssue(state)))

/** Internal optimistic-concurrency wire shape. It is intentionally exported
 * only through the Effect subpath, never as a public contract. */
export const InternalUpdateSpaceTaskRequestSchema = Schema.Struct({
  expected_updated_at: WorkTimestampSchema,
  ...updateSpaceTaskPatchFields
})

export const decodeSpaceTaskEventEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SpaceTaskEventSchema)(value)

export const decodeSpaceSnapshotEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SpaceSnapshotSchema)(value)

export const decodeSpaceTaskRunEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SpaceTaskRunSchema)(value)

export const decodeCreateSpaceTaskInputEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateSpaceTaskInputSchema)(value, strict).pipe(
    Effect.map((input) => (input.body?.trim() === "" ? { ...input, body: null } : input))
  )

export const decodeCreateSpaceTaskCommentInputEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateSpaceTaskCommentInputSchema)(value, strict)

export const decodeCreateSpaceTaskAttachmentInputEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateSpaceTaskAttachmentInputSchema)(value, strict)

export const decodeUpdateSpaceTaskPatchEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(UpdateSpaceTaskPatchSchema)(value, strict).pipe(
    Effect.map((patch) => (patch.body?.trim() === "" ? { ...patch, body: null } : patch))
  )

export const encodeNewTaskRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(NewTaskInputSchema)(value, strict).pipe(
    Effect.map((input) =>
      JSON.stringify(input.body?.trim() === "" ? { ...input, body: null } : input)
    )
  )

export const encodeCreateLooseTaskRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateLooseTaskInputSchema)(value, strict).pipe(
    Effect.map((input) =>
      JSON.stringify(input.body?.trim() === "" ? { ...input, body: null } : input)
    )
  )

export const encodeCreateSpaceTaskCommentRequestEffect = (value: unknown) =>
  decodeCreateSpaceTaskCommentInputEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeCreateSpaceTaskAttachmentRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateSpaceTaskAttachmentConsumerInputSchema)(value, strict).pipe(
    Effect.flatMap((input) =>
      Schema.encodeEffect(CreateSpaceTaskAttachmentInputSchema)({
        name: input.name,
        media_type: input.mediaType,
        data: input.bytes
      })
    ),
    Effect.map(JSON.stringify)
  )

export const encodeUpdateSpaceTaskRequestEffect = (currentTask: unknown, patch: unknown) =>
  Schema.decodeUnknownEffect(SpaceTaskSchema)(currentTask).pipe(
    Effect.flatMap((task) =>
      decodeUpdateSpaceTaskPatchEffect(patch).pipe(
        Effect.flatMap((validatedPatch) => {
          const normalizedPatch =
            validatedPatch.blocked === false && !Object.hasOwn(validatedPatch, "waiting_on")
              ? { ...validatedPatch, waiting_on: null }
              : validatedPatch

          return Schema.decodeUnknownEffect(SpaceTaskBlockStateSchema)({
            blocked: normalizedPatch.blocked ?? task.blocked,
            waiting_on: Object.hasOwn(normalizedPatch, "waiting_on")
              ? (normalizedPatch.waiting_on ?? null)
              : task.waiting_on
          }).pipe(
            Effect.map(() => ({
              expected_updated_at: task.updated_at,
              ...normalizedPatch
            }))
          )
        })
      )
    ),
    Effect.flatMap((request) =>
      Schema.decodeUnknownEffect(InternalUpdateSpaceTaskRequestSchema)(request, strict)
    ),
    Effect.map(JSON.stringify)
  )

export const encodeStopSpaceTaskRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(StopSpaceTaskInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

/** @internal Compile-time check that the schema and the type agree. */
export type SpaceTaskStatusAgrees = Assert<
  Agrees<(typeof SpaceTaskStatusSchema)["Type"], SpaceTaskStatus>
>

/** @internal Compile-time check that the schema and the type agree. */
export type SpaceTaskActivityAgrees = Assert<
  Agrees<(typeof SpaceTaskActivitySchema)["Type"], SpaceTaskActivity>
>
