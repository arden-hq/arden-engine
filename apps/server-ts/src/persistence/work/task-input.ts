import { PositiveIntSchema } from "@arden-hq/protocol/effect/common"
import {
  TaskBodyInputSchema,
  TaskOwnerSchema,
  TaskRunsInSchema,
  TaskTextInputSchema,
  WorkTaskKeySchema
} from "@arden-hq/protocol/effect/spaces/work"
import { TOKEN_CAP, type TokenCap } from "@arden-hq/protocol/settings"
import {
  TASK_BODY,
  type CreateChatTaskInput,
  type NewTaskInput
} from "@arden-hq/protocol/spaces/work"
import { Effect, Schema } from "effect"

const taskDraftFields = {
  text: TaskTextInputSchema,
  body: Schema.optionalKey(Schema.NullOr(TaskBodyInputSchema)),
  owner: Schema.optionalKey(TaskOwnerSchema),
  runs_in: Schema.optionalKey(TaskRunsInSchema),
  token_budget: Schema.optionalKey(PositiveIntSchema)
} as const

export const TaskDraftSchema = Schema.Struct(taskDraftFields)

export const KeyedTaskDraftSchema = Schema.Struct({
  key: WorkTaskKeySchema,
  ...taskDraftFields
})

export type TaskDraft = typeof TaskDraftSchema.Type
export type KeyedTaskDraft = typeof KeyedTaskDraftSchema.Type

export interface ChatTaskDraft {
  readonly request: string
  readonly token_budget?: number
}

export const decodeKeyedTaskDraftEffect = (
  value: unknown
): Effect.Effect<KeyedTaskDraft, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(KeyedTaskDraftSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.map((input) =>
      typeof input.body === "string" && input.body.trim().length === 0
        ? { ...input, body: null }
        : input
    )
  )

const tokenBudget = (cap: TokenCap): { readonly token_budget?: number } =>
  cap.kind === TOKEN_CAP.capped ? { token_budget: cap.tokens } : {}

export const taskDraft = (input: NewTaskInput): TaskDraft => ({
  text: input.text,
  body:
    input.body.kind === TASK_BODY.detailed && input.body.text.trim().length > 0
      ? input.body.text
      : null,
  owner: input.owner,
  runs_in: input.runs_in,
  ...tokenBudget(input.token_budget)
})

export const chatTaskDraft = (input: CreateChatTaskInput): ChatTaskDraft => ({
  request: input.request,
  ...tokenBudget(input.token_budget)
})
