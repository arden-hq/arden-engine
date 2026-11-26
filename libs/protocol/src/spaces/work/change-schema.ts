import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, PositiveIntSchema } from "../../common/schema.js"
import { TASK_STATE_LINE_MAX_CHARS, TASK_STATE_SECTION_MAX_LINES } from "./contracts.js"
import { TaskBodySchema, TaskTokenCapSchema } from "./input-schema.js"
import {
  DueAtSchema,
  SpaceTaskStatusSchema,
  TaskOwnerSchema,
  TaskRunsInSchema,
  TaskTextInputSchema,
  TaskWaitingOnSchema
} from "./schema.js"

const boundedTrimmed = (maximum: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

const stateLine = boundedTrimmed(TASK_STATE_LINE_MAX_CHARS)
const stateLines = <S extends Schema.Top>(line: S) =>
  Schema.Array(line).check(Schema.isMaxLength(TASK_STATE_SECTION_MAX_LINES))

const TaskStateSectionSchema = Schema.Union([
  Schema.Struct({ section: Schema.Literal("done"), lines: stateLines(stateLine) }),
  Schema.Struct({
    section: Schema.Literal("in_progress"),
    jobs: stateLines(
      Schema.Struct({
        what: stateLine,
        handle: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("untracked") }),
          Schema.Struct({ kind: Schema.Literal("tracked"), handle: stateLine })
        ]).pipe(Schema.toTaggedUnion("kind"))
      })
    )
  }),
  Schema.Struct({ section: Schema.Literal("decided"), lines: stateLines(stateLine) }),
  Schema.Struct({
    section: Schema.Literal("rejected"),
    options: stateLines(Schema.Struct({ option: stateLine, why: stateLine }))
  }),
  Schema.Struct({ section: Schema.Literal("next"), lines: stateLines(stateLine) })
]).pipe(Schema.toTaggedUnion("section"))

const CompletionEvidenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    attachment_id: PositiveIntSchema,
    description: boundedTrimmed(500)
  }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    tool_call_id: boundedTrimmed(512),
    description: boundedTrimmed(500)
  })
]).pipe(Schema.toTaggedUnion("kind"))

const TaskChangeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("state_record"),
    record: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("cleared") }),
      Schema.Struct({
        kind: Schema.Literal("rewritten"),
        sections: Schema.Array(TaskStateSectionSchema).check(Schema.isMinLength(1))
      })
    ]).pipe(Schema.toTaggedUnion("kind"))
  }),
  Schema.Struct({ kind: Schema.Literal("status"), status: SpaceTaskStatusSchema }),
  Schema.Struct({
    kind: Schema.Literal("complete"),
    result: boundedTrimmed(500),
    evidence: Schema.Array(CompletionEvidenceSchema).check(Schema.isMaxLength(20)),
    note: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("none") }),
      Schema.Struct({ kind: Schema.Literal("note"), text: boundedTrimmed(1_000) })
    ]).pipe(Schema.toTaggedUnion("kind"))
  }),
  Schema.Struct({ kind: Schema.Literal("text"), text: TaskTextInputSchema }),
  Schema.Struct({ kind: Schema.Literal("body"), body: TaskBodySchema }),
  Schema.Struct({ kind: Schema.Literal("owner"), owner: TaskOwnerSchema }),
  Schema.Struct({ kind: Schema.Literal("runs_in"), runs_in: TaskRunsInSchema }),
  Schema.Struct({ kind: Schema.Literal("token_budget"), token_budget: TaskTokenCapSchema }),
  Schema.Struct({
    kind: Schema.Literal("block"),
    block: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("unblocked") }),
      Schema.Struct({
        kind: Schema.Literal("blocked"),
        waiting_on: TaskWaitingOnSchema,
        reason: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("unstated") }),
          Schema.Struct({ kind: Schema.Literal("stated"), text: boundedTrimmed(200) })
        ]).pipe(Schema.toTaggedUnion("kind"))
      })
    ]).pipe(Schema.toTaggedUnion("kind"))
  }),
  Schema.Struct({
    kind: Schema.Literal("due"),
    due: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("none") }),
      Schema.Struct({ kind: Schema.Literal("due"), at: DueAtSchema })
    ]).pipe(Schema.toTaggedUnion("kind"))
  }),
  Schema.Struct({
    kind: Schema.Literal("next_attempt"),
    next_attempt: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("none") }),
      Schema.Struct({ kind: Schema.Literal("at"), at: IsoDateTimeStringSchema })
    ]).pipe(Schema.toTaggedUnion("kind"))
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const UpdateSpaceTaskRequestSchema = Schema.Struct({
  expected_updated_at: IsoDateTimeStringSchema,
  changes: Schema.Array(TaskChangeSchema).check(
    Schema.makeFilter((changes) =>
      changes.length > 0 ? undefined : "an update requires at least one field"
    )
  )
})

export const encodeUpdateSpaceTaskRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(UpdateSpaceTaskRequestSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))
