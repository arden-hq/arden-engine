import { Schema } from "effect"
import { PositiveIntSchema } from "../../common/schema.js"
import { WORK_TASK_BODY_MAX_CHARS } from "./contracts.js"
import {
  TaskBodyInputSchema,
  TaskOwnerSchema,
  TaskRunsInSchema,
  TaskTextInputSchema
} from "./schema.js"

const boundedTrimmed = (maximum: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

export const TaskBodySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("plain") }),
  Schema.Struct({ kind: Schema.Literal("detailed"), text: TaskBodyInputSchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const TaskTokenCapSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("uncapped") }),
  Schema.Struct({ kind: Schema.Literal("capped"), tokens: PositiveIntSchema })
]).pipe(Schema.toTaggedUnion("kind"))

const newTaskInputFields = {
  text: TaskTextInputSchema,
  body: TaskBodySchema,
  owner: TaskOwnerSchema,
  runs_in: TaskRunsInSchema,
  token_budget: TaskTokenCapSchema
} as const

export const NewTaskInputSchema = Schema.Struct(newTaskInputFields)

export const CreateChatTaskInputSchema = Schema.Struct({
  request: boundedTrimmed(WORK_TASK_BODY_MAX_CHARS),
  token_budget: TaskTokenCapSchema
})

export const CreateLooseTaskInputSchema = Schema.Struct({
  ...newTaskInputFields,
  home: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("standalone") }),
    Schema.Struct({ kind: Schema.Literal("chat"), session_id: Schema.NonEmptyString })
  ]).pipe(Schema.toTaggedUnion("kind"))
})
