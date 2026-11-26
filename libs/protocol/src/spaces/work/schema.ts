import { checkRunApprovalConnection, runApprovalFields } from "../../runs/approval-schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import { WikiPageIdSchema } from "../../wiki/schema/shared.js"
import { Effect, Schema, SchemaTransformation, type SchemaAST } from "effect"
import type {
  SpaceTask,
  SpaceTaskActivity,
  SpaceTaskStatus,
  SpaceTaskComment,
  SpaceTaskAttachment,
  SpaceWorkPage
} from "./contracts.js"
import {
  EVENT_CONTENT,
  EVIDENCE_PROVIDER,
  SPACE_TASK_CAPTURE_BASIS,
  SPACE_TASK_COMMENT_KIND,
  SPACE_TASK_CREATED_BY,
  SPACE_TASK_EVENT_TYPE,
  SPACE_TASK_OWNER,
  SPACE_TASK_RUNS_IN,
  SPACE_TASK_STOP_KIND,
  SPACE_TASK_WAITING_ON,
  TASK_ACTIVITY,
  TASK_STATUS
} from "./contracts.js"
import { STOP_SPACE_TASK_RUN_OUTCOME, STOP_SPACE_TASK_STATE } from "./input-contracts.js"
import type { StopSpaceTaskResponse } from "./input-contracts.js"
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
  WORK_TASK_BODY_MAX_CHARS,
  WORK_TASK_KEY_MAX_CHARS,
  WORK_TASK_TEXT_MAX_CHARS
} from "./contracts.js"

const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }
type EncodedText = Effect.Effect<string, Schema.SchemaError>
const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))
const TrimmedTextSchema = Schema.Trim.check(Schema.isMinLength(1))
const WorkTimestampSchema = IsoDateTimeStringSchema
export const DueAtSchema = Schema.String.check(Schema.isMaxLength(512))

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

export const TaskTextInputSchema = boundedTrimmed(WORK_TASK_TEXT_MAX_CHARS).check(noLineBreaks)
export const TaskBodyInputSchema = Schema.String.check(Schema.isMaxLength(WORK_TASK_BODY_MAX_CHARS))
const commentBodyInputSchema = boundedTrimmed(WORK_COMMENT_BODY_MAX_CHARS)
export const SpaceTaskStatusSchema = Schema.Literals(Object.values(TASK_STATUS))
export const SpaceTaskActivitySchema = Schema.Literals(Object.values(TASK_ACTIVITY))
export const TaskWaitingOnSchema = Schema.Literals(Object.values(SPACE_TASK_WAITING_ON))
export const TaskOwnerSchema = Schema.Literals(Object.values(SPACE_TASK_OWNER))
export const TaskRunsInSchema = Schema.Literals(Object.values(SPACE_TASK_RUNS_IN))
export const SpaceTaskEventTypeSchema = Schema.Literals(Object.values(SPACE_TASK_EVENT_TYPE))
export const isSpaceTaskEventType = Schema.is(SpaceTaskEventTypeSchema)
export const SpaceTaskEventContentKindSchema = Schema.Literals(Object.values(EVENT_CONTENT))
export const SpaceTaskCreatedBySchema = Schema.Union([
  Schema.Literals(Object.values(SPACE_TASK_CREATED_BY)),
  Schema.TemplateLiteral(["automation:", Schema.String])
])
export const TaskCommentKindSchema = Schema.Literals(Object.values(SPACE_TASK_COMMENT_KIND))

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
  provider: Schema.Literal(EVIDENCE_PROVIDER.arden),
  kind: evidenceKindSchema,
  ref: ardenPublicRefSchema,
  title: evidenceTitleSchema
})

const providerEvidenceSourceRefSchema = withExtras({
  provider: boundedTrimmed(64).check(
    Schema.makeFilter((value) =>
      /^[a-z0-9][a-z0-9_-]*$/.test(value) && value !== EVIDENCE_PROVIDER.arden
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
  basis: Schema.Literals([
    SPACE_TASK_CAPTURE_BASIS.explicit,
    SPACE_TASK_CAPTURE_BASIS.long_horizon,
    SPACE_TASK_CAPTURE_BASIS.inferred
  ]).annotate({
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
  Schema.Struct({ basis: Schema.Literal(SPACE_TASK_CAPTURE_BASIS.unrecorded), reason: Schema.Null })
])
const tag = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  kind: Tag,
  fields: Fields
) => Schema.Struct({ kind: Schema.Literal(kind), ...fields })

const sourceRevisionSchema = Schema.Union([
  tag("unrecorded", {}),
  tag("recorded", { revision: sourceIdentitySchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const SpaceTaskSourceSchema = Schema.Union([
  tag("chat", {
    session_id: sourceIdentitySchema,
    turn: Schema.Union([
      tag("whole_chat", {}),
      tag("turn", { turn_id: sourceIdentitySchema })
    ]).pipe(Schema.toTaggedUnion("kind")),
    revision: sourceRevisionSchema
  }),
  tag("memory", { page_ref: WikiPageIdSchema, revision: sourceIdentitySchema }),
  tag("task", { item_id: sourceIdentitySchema, revision: sourceRevisionSchema }),
  tag("space", { space_id: sourceIdentitySchema, revision: sourceRevisionSchema }),
  tag("connection_item", { item_id: sourceIdentitySchema, revision: sourceIdentitySchema })
]).pipe(Schema.toTaggedUnion("kind"))

const SpaceTaskEvidenceSchema = Schema.Union([
  tag("tool_call", {
    tool_call_id: NonEmptyStringSchema,
    tool_name: NonEmptyStringSchema,
    exit: Schema.Union([tag("unknown", {}), tag("exited", { code: Schema.Int })]).pipe(
      Schema.toTaggedUnion("kind")
    )
  }),
  tag("file", {
    path: NonEmptyStringSchema,
    size: NonNegativeIntSchema,
    modified_at: Schema.String
  }),
  tag("attachment", { attachment_id: PositiveIntSchema, name: NonEmptyStringSchema }),
  tag("url", { url: NonEmptyStringSchema, tool_call_id: NonEmptyStringSchema })
]).pipe(Schema.toTaggedUnion("kind"))

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
    met: Schema.Union([
      tag("unmet", {}),
      tag("met", { evidence: SpaceTaskEvidenceSchema, recorded_at: Schema.String })
    ]).pipe(Schema.toTaggedUnion("kind"))
  }),
  Schema.Struct({
    line_id: PositiveIntSchema,
    kind: Schema.Literal("decision"),
    text: NonEmptyStringSchema,
    rejected: Schema.Union([
      tag("none", {}),
      tag("rejected", { option: NonEmptyStringSchema })
    ]).pipe(Schema.toTaggedUnion("kind"))
  })
])

const TaskBodyReadSchema = Schema.Union([
  tag("plain", {}),
  tag("detailed", { text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const TaskJobSchema = Schema.Struct({
  what: Schema.String,
  handle: Schema.Union([tag("untracked", {}), tag("tracked", { handle: Schema.String })]).pipe(
    Schema.toTaggedUnion("kind")
  )
})

const TaskSpaceSchema = Schema.Union([
  tag("loose", {}),
  tag("space", { space_id: NonEmptyStringSchema })
]).pipe(Schema.toTaggedUnion("kind"))

const spaceTaskFields = {
  history: Schema.Union([
    tag("unrecorded", {}),
    tag("recorded", { revision: NonEmptyStringSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  item_id: NonEmptyStringSchema,
  space: TaskSpaceSchema,
  home_chat: Schema.Union([
    tag("none", {}),
    tag("chat", { session_id: NonEmptyStringSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  stable_key: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  body: TaskBodyReadSchema,
  activity: Schema.Union([
    Schema.Struct({
      kind: Schema.Literals([
        TASK_ACTIVITY.idle,
        TASK_ACTIVITY.working,
        TASK_ACTIVITY.needs_you,
        TASK_ACTIVITY.waiting,
        TASK_ACTIVITY.on_hold
      ])
    }),
    tag("stopped", {
      stop: Schema.Union([
        tag("unrecorded", {}),
        tag("recorded", {
          stop_kind: Schema.Literals(Object.values(SPACE_TASK_STOP_KIND)),
          reason: Schema.String
        })
      ]).pipe(Schema.toTaggedUnion("kind"))
    })
  ]),
  hold: Schema.Union([
    tag("none", {}),
    tag("held", { question_id: NonEmptyStringSchema, acknowledged_at: WorkTimestampSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  owner: TaskOwnerSchema,
  runs_in: TaskRunsInSchema,
  token_budget: Schema.Union([
    tag("uncapped", {}),
    tag("capped", { tokens: PositiveIntSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  block: Schema.Union([
    tag("unblocked", {}),
    tag("blocked", { waiting_on: TaskWaitingOnSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  due: Schema.Union([tag("none", {}), tag("due", { at: DueAtSchema })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  next_attempt: Schema.Union([tag("none", {}), tag("at", { at: WorkTimestampSchema })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  created_at: WorkTimestampSchema,
  updated_at: WorkTimestampSchema,
  created_by: Schema.Union([
    tag("unrecorded", {}),
    tag("recorded", { by: SpaceTaskCreatedBySchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  seq: Schema.Union([tag("unnumbered", {}), tag("numbered", { seq: NonNegativeIntSchema })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  block_count: NonNegativeIntSchema,
  sources: Schema.Array(SpaceTaskSourceSchema),
  capture: SpaceTaskCaptureSchema,
  contract: Schema.Array(SpaceTaskContractLineSchema),
  state: Schema.Union([
    tag("unwritten", {}),
    tag("written", {
      done: Schema.Array(Schema.String),
      in_progress: Schema.Array(TaskJobSchema),
      decided: Schema.Array(Schema.String),
      rejected: Schema.Array(Schema.Struct({ option: Schema.String, why: Schema.String })),
      next: Schema.Array(Schema.String),
      written_at: Schema.String
    })
  ]).pipe(Schema.toTaggedUnion("kind"))
} as const

export const SpaceTaskSchema: Schema.Codec<SpaceTask> = Schema.Union([
  withExtras({
    ...spaceTaskFields,
    status: Schema.Literals([TASK_STATUS.open, TASK_STATUS.deferred])
  }),
  withExtras({
    ...spaceTaskFields,
    status: Schema.Literals([TASK_STATUS.done, TASK_STATUS.cancelled]),
    completed_at: WorkTimestampSchema
  })
])

export const SpaceTaskAttachmentSchema: Schema.Codec<SpaceTaskAttachment> = withExtras({
  attachment_id: PositiveIntSchema,
  space: TaskSpaceSchema,
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
  space: TaskSpaceSchema,
  item_id: NonEmptyStringSchema,
  author: NonEmptyStringSchema,
  body: NonEmptyStringSchema,
  created_at: WorkTimestampSchema,
  kind: TaskCommentKindSchema
})

export const SpaceTaskEventSchema = withExtras({
  event_id: PositiveIntSchema,
  space: TaskSpaceSchema,
  item: Schema.Union([tag("space_wide", {}), tag("item", { item_id: Schema.String })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  run: Schema.Union([tag("none", {}), tag("run", { run_ref: Schema.String })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  event_type: SpaceTaskEventTypeSchema,
  content: Schema.Struct({
    kind: SpaceTaskEventContentKindSchema,
    text: NonEmptyStringSchema
  }),
  source_refs: Schema.Array(EvidenceSourceRefSchema),
  created_at: WorkTimestampSchema
}).check(
  Schema.makeFilter((event) =>
    event.content.kind === EVENT_CONTENT.result && event.event_type !== SPACE_TASK_EVENT_TYPE.done
      ? { path: ["content"], issue: "a completion result requires a Done event" }
      : undefined
  )
)

const RunRefSchema = Schema.Union([
  tag("none", {}),
  tag("run", { run_id: NonEmptyStringSchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const SpaceTaskResultSchema = withExtras({
  result_key: NonEmptyStringSchema,
  summary: Schema.Union([tag("none", {}), tag("summary", { text: boundedTrimmed(500) })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  unseen: Schema.Boolean,
  item_id: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  created_at: WorkTimestampSchema,
  source: Schema.Union([
    tag("event", { event_id: PositiveIntSchema }),
    tag("attempt", { attempt_id: PositiveIntSchema, run: RunRefSchema })
  ]).pipe(Schema.toTaggedUnion("kind"))
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
  run: Schema.Union([
    tag("none", {}),
    tag("running", {
      run_id: PositiveIntSchema,
      chat_run: RunRefSchema,
      started_at: WorkTimestampSchema
    }),
    tag("ended", {
      run_id: PositiveIntSchema,
      chat_run: RunRefSchema,
      started_at: WorkTimestampSchema,
      ended_at: WorkTimestampSchema,
      result: Schema.Union([tag("none", {}), tag("result", { text: Schema.String })]).pipe(
        Schema.toTaggedUnion("kind")
      )
    })
  ]).pipe(Schema.toTaggedUnion("kind"))
})

export const MoveTaskToChatInputSchema = Schema.Struct({ session_id: NonEmptyStringSchema })
export const AcknowledgeTaskResultInputSchema = Schema.Struct({ result_key: NonEmptyStringSchema })
export const StopSpaceTaskInputSchema = Schema.Struct({ expected_updated_at: WorkTimestampSchema })
const StopSpaceTaskRunResultSchema = Schema.Struct({
  run_id: NonEmptyStringSchema,
  outcome: Schema.Literals(Object.values(STOP_SPACE_TASK_RUN_OUTCOME))
})
export const StopSpaceTaskResponseSchema: Schema.Codec<StopSpaceTaskResponse> = withExtras({
  task: SpaceTaskSchema,
  authority: Schema.Literal("revoked"),
  state: Schema.Literals(Object.values(STOP_SPACE_TASK_STATE)),
  runs: Schema.Array(StopSpaceTaskRunResultSchema)
})

export type StopSpaceTaskResponseAgrees = Assert<
  Agrees<(typeof StopSpaceTaskResponseSchema)["Type"], StopSpaceTaskResponse>
>
export const TaskApprovalSchema = withExtras({
  ...runApprovalFields,
  item_id: Schema.String
}).check(Schema.makeFilter(checkRunApprovalConnection))

export const WorkOkResponseSchema = Schema.Struct({ ok: Schema.Literal(true) })
export const SpaceWorkPageSchema: Schema.Codec<SpaceWorkPage> = withExtras({
  items: Schema.Array(SpaceTaskSchema),
  events: Schema.Array(SpaceTaskEventSchema),
  comments: Schema.Array(SpaceTaskCommentSchema),
  attachments: Schema.Array(SpaceTaskAttachmentSchema),
  runs: Schema.Array(SpaceTaskRunSchema),
  results: Schema.Array(SpaceTaskResultSchema),
  approvals: Schema.Array(TaskApprovalSchema),
  next: Schema.Union([
    tag("end", {}),
    tag("more", { cursor: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)) })
  ]).pipe(Schema.toTaggedUnion("kind"))
})

export const CreateSpaceTaskCommentInputSchema = Schema.Struct({
  body: commentBodyInputSchema
})

export const CreateSpaceTaskAttachmentInputSchema = Schema.Struct({
  name: boundedTrimmed(WORK_ATTACHMENT_NAME_MAX_CHARS),
  media_type: mediaTypeInputSchema,
  data: attachmentBytesFromBase64Schema
})

export type CreateSpaceTaskAttachmentRequest = typeof CreateSpaceTaskAttachmentInputSchema.Type

export type SpaceTaskStatusAgrees = Assert<
  Agrees<(typeof SpaceTaskStatusSchema)["Type"], SpaceTaskStatus>
>

export type SpaceTaskActivityAgrees = Assert<
  Agrees<(typeof SpaceTaskActivitySchema)["Type"], SpaceTaskActivity>
>

const CreateSpaceTaskAttachmentConsumerInputSchema = Schema.Struct({
  name: boundedTrimmed(WORK_ATTACHMENT_NAME_MAX_CHARS),
  mediaType: mediaTypeInputSchema,
  bytes: attachmentBytesSchema
})

export const encodeCreateSpaceTaskAttachmentRequestEffect = (value: unknown): EncodedText =>
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
