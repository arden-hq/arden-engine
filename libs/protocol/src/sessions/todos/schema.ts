import { Effect, Schema, type SchemaAST } from "effect"
import {
  IsoDateTimeStringSchema,
  PlannedTodoStatusSchema,
  TodoListItemSchema,
  withExtras
} from "../../common/schema.js"
import {
  SESSION_TODO,
  TODO_EXPLANATION,
  TODO_REASON,
  TODO_STATUS,
  type TodoSnapshot,
  type EffectiveSessionTodoResponse,
  type TodoLifecycleResponse
} from "./contracts.js"

const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }
const TodoContentSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))

const explanationSchema = <Text extends Schema.Top>(text: Text) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal(TODO_EXPLANATION.none) }),
    Schema.Struct({ kind: Schema.Literal(TODO_EXPLANATION.given), text })
  ])

const TodoExplanationSchema = explanationSchema(Schema.String)

export const SetTodoOverrideRequestSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Union([
      Schema.Struct({ content: TodoContentSchema, status: PlannedTodoStatusSchema }),
      Schema.Struct({
        content: TodoContentSchema,
        status: Schema.Literal(TODO_STATUS.cancelled),
        reason: Schema.Union([
          Schema.Struct({ kind: Schema.Literal(TODO_REASON.unstated) }),
          Schema.Struct({
            kind: Schema.Literal(TODO_REASON.stated),
            text: Schema.String.check(Schema.isMaxLength(300))
          })
        ])
      })
    ])
  ).check(Schema.isMaxLength(50)),
  explanation: explanationSchema(Schema.String.check(Schema.isMaxLength(2_000)))
})

const todoFields = {
  items: Schema.Array(TodoListItemSchema),
  explanation: TodoExplanationSchema,
  updated_at: IsoDateTimeStringSchema
}

export const TodoSnapshotSchema: Schema.Codec<TodoSnapshot> = withExtras(todoFields)

export const EffectiveSessionTodoResponseSchema: Schema.Codec<EffectiveSessionTodoResponse> =
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SESSION_TODO.none) }),
    withExtras({ ...todoFields, kind: Schema.Literal(SESSION_TODO.list), edited: Schema.Boolean })
  ])

export const TodoLifecycleResponseSchema: Schema.Codec<TodoLifecycleResponse> = withExtras({
  status: Schema.Literals(["cleared", "noop"] as const),
  session_id: Schema.NonEmptyString
})

const decodeSetTodoOverrideRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SetTodoOverrideRequestSchema)(value, strict)

export const encodeSetTodoOverrideRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  decodeSetTodoOverrideRequestEffect(value).pipe(Effect.map(JSON.stringify))
