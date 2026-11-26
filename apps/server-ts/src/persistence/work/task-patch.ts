import { IsoDateTimeStringSchema, PositiveIntSchema } from "@arden-hq/protocol/effect/common"
import {
  DueAtSchema,
  SpaceTaskStatusSchema,
  TaskBodyInputSchema,
  TaskOwnerSchema,
  TaskRunsInSchema,
  TaskTextInputSchema,
  TaskWaitingOnSchema
} from "@arden-hq/protocol/effect/spaces/work"
import { TOKEN_CAP } from "@arden-hq/protocol/settings"
import {
  BLOCK_REASON,
  COMPLETION_NOTE,
  JOB_HANDLE,
  STATE_RECORD_CHANGE,
  STATE_SECTION,
  TASK_BLOCK,
  TASK_BODY,
  TASK_CHANGE,
  TASK_DUE,
  TASK_NEXT_ATTEMPT,
  TASK_STATE_LINE_MAX_CHARS,
  TASK_STATE_SECTION_MAX_LINES,
  TASK_STATUS,
  type TaskChange,
  type TaskStateRecordChange,
  type TaskStateSection
} from "@arden-hq/protocol/spaces/work"
import { Effect, Schema, type SchemaAST } from "effect"

const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }
const boundedTrimmed = (maximum: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

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
  text: Schema.optionalKey(TaskTextInputSchema),
  body: Schema.optionalKey(Schema.NullOr(TaskBodyInputSchema)),
  status: Schema.optionalKey(SpaceTaskStatusSchema),
  owner: Schema.optionalKey(TaskOwnerSchema),
  runs_in: Schema.optionalKey(TaskRunsInSchema),
  token_budget: Schema.optionalKey(Schema.NullOr(PositiveIntSchema)),
  blocked: Schema.optionalKey(Schema.Boolean),
  waiting_on: Schema.optionalKey(Schema.NullOr(TaskWaitingOnSchema)),
  block_reason: Schema.optionalKey(boundedTrimmed(200)),
  due_at: Schema.optionalKey(Schema.NullOr(DueAtSchema)),
  next_attempt_at: Schema.optionalKey(Schema.NullOr(IsoDateTimeStringSchema))
} as const

export const TaskPatchSchema = Schema.Struct(updateSpaceTaskPatchFields).check(
  Schema.makeFilter((patch) =>
    Object.keys(patch).length > 0 ? undefined : "an update requires at least one field"
  ),
  Schema.makeFilter((patch) =>
    patch.completion_result !== undefined && patch.status !== TASK_STATUS.done
      ? { path: ["completion_result"], issue: "requires an explicit Done transition" }
      : undefined
  ),
  Schema.makeFilter((patch) =>
    (patch.completion_evidence !== undefined || patch.completion_note !== undefined) &&
    (patch.status !== TASK_STATUS.done || patch.completion_result === undefined)
      ? "Completion evidence and notes require a completion_result and explicit Done transition"
      : undefined
  )
)

const InternalUpdateSpaceTaskRequestSchema = Schema.Struct({
  expected_updated_at: IsoDateTimeStringSchema,
  ...updateSpaceTaskPatchFields
})

export type TaskPatch = typeof TaskPatchSchema.Type
export type TaskStateRecordPatch = NonNullable<TaskPatch["continuation_context"]>

export const decodeUpdateSpaceTaskPatchEffect = (
  value: unknown
): Effect.Effect<TaskPatch, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(TaskPatchSchema)(value, strict).pipe(
    Effect.map((patch) =>
      typeof patch.body === "string" && patch.body.trim().length === 0
        ? { ...patch, body: null }
        : patch
    )
  )

const withSection = (
  patch: TaskStateRecordPatch,
  section: TaskStateSection
): TaskStateRecordPatch => {
  switch (section.section) {
    case STATE_SECTION.done:
      return { ...patch, done: section.lines }
    case STATE_SECTION.in_progress:
      return {
        ...patch,
        in_progress: section.jobs.map((job) =>
          job.handle.kind === JOB_HANDLE.tracked
            ? { what: job.what, handle: job.handle.handle }
            : { what: job.what }
        )
      }
    case STATE_SECTION.decided:
      return { ...patch, decided: section.lines }
    case STATE_SECTION.rejected:
      return { ...patch, rejected: section.options }
    case STATE_SECTION.next:
      return { ...patch, next: section.lines }
  }
}

const recordPatch = (record: TaskStateRecordChange): TaskStateRecordPatch | null =>
  record.kind === STATE_RECORD_CHANGE.cleared
    ? null
    : record.sections.reduce<TaskStateRecordPatch>(withSection, {})

const applyChange = (patch: TaskPatch, change: TaskChange): TaskPatch => {
  switch (change.kind) {
    case TASK_CHANGE.state_record:
      return { ...patch, continuation_context: recordPatch(change.record) }
    case TASK_CHANGE.status:
      return { ...patch, status: change.status }
    case TASK_CHANGE.complete:
      return {
        ...patch,
        status: TASK_STATUS.done,
        completion_result: change.result,
        ...(change.evidence.length === 0 ? {} : { completion_evidence: change.evidence }),
        ...(change.note.kind === COMPLETION_NOTE.note ? { completion_note: change.note.text } : {})
      }
    case TASK_CHANGE.text:
      return { ...patch, text: change.text }
    case TASK_CHANGE.body:
      return {
        ...patch,
        body:
          change.body.kind === TASK_BODY.detailed && change.body.text.trim().length > 0
            ? change.body.text
            : null
      }
    case TASK_CHANGE.owner:
      return { ...patch, owner: change.owner }
    case TASK_CHANGE.runs_in:
      return { ...patch, runs_in: change.runs_in }
    case TASK_CHANGE.token_budget:
      return {
        ...patch,
        token_budget:
          change.token_budget.kind === TOKEN_CAP.capped ? change.token_budget.tokens : null
      }
    case TASK_CHANGE.block:
      return change.block.kind === TASK_BLOCK.unblocked
        ? { ...patch, blocked: false }
        : {
            ...patch,
            blocked: true,
            waiting_on: change.block.waiting_on,
            ...(change.block.reason.kind === BLOCK_REASON.stated
              ? { block_reason: change.block.reason.text }
              : {})
          }
    case TASK_CHANGE.due:
      return { ...patch, due_at: change.due.kind === TASK_DUE.due ? change.due.at : null }
    case TASK_CHANGE.next_attempt:
      return {
        ...patch,
        next_attempt_at:
          change.next_attempt.kind === TASK_NEXT_ATTEMPT.at ? change.next_attempt.at : null
      }
  }
}

export const taskPatchOf = (changes: ReadonlyArray<TaskChange>): TaskPatch =>
  changes.reduce(applyChange, {})

export const decodeTaskUpdateRequestEffect = (
  expectedUpdatedAt: string,
  patch: TaskPatch
): Effect.Effect<typeof InternalUpdateSpaceTaskRequestSchema.Type, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(InternalUpdateSpaceTaskRequestSchema)({
    expected_updated_at: expectedUpdatedAt,
    ...patch
  })
