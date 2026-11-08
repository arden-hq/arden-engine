import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, TodoListItemSchema, withExtras } from "../../common/schema.js"
import type {
  TodoSnapshot,
  EffectiveSessionTodoResponse,
  TodoLifecycleResponse
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
const TodoContentSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))
const TodoStatusSchema = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "cancelled"
] as const)

const TodoOverrideItemRequestSchema = Schema.Struct({
  content: TodoContentSchema,
  status: TodoStatusSchema,
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300)))
})

export const SetTodoOverrideRequestSchema = Schema.Struct({
  items: Schema.Array(TodoOverrideItemRequestSchema).check(Schema.isMaxLength(50)),
  explanation: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))))
})

export const TodoSnapshotSchema: Schema.Codec<TodoSnapshot> = withExtras({
  items: Schema.Array(TodoListItemSchema),
  explanation: Schema.NullOr(Schema.String),
  updated_at: IsoDateTimeStringSchema
})

const EffectiveSessionTodoSchema = withExtras({
  items: Schema.Array(TodoListItemSchema),
  explanation: Schema.NullOr(Schema.String),
  updated_at: IsoDateTimeStringSchema,
  edited: Schema.Boolean
})

export const EffectiveSessionTodoResponseSchema: Schema.Codec<EffectiveSessionTodoResponse> =
  Schema.NullOr(EffectiveSessionTodoSchema)

export const TodoLifecycleResponseSchema: Schema.Codec<TodoLifecycleResponse> = withExtras({
  status: Schema.Literals(["cleared", "noop"] as const),
  session_id: Schema.NonEmptyString
})

const decodeSetTodoOverrideRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SetTodoOverrideRequestSchema)(value, strict)

export const encodeSetTodoOverrideRequestEffect = (value: unknown) =>
  decodeSetTodoOverrideRequestEffect(value).pipe(Effect.map(JSON.stringify))
