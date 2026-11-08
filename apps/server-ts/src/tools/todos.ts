import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema, SchemaTransformation } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { TodoStore, TodoStoreError } from "../persistence/todos/store.js"
import { toolFailure } from "./tool-failure.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt } from "./call-receipt.js"

const TodoTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))
const TodoStatusSchema = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "cancelled"
] as const).annotate({
  description:
    "Current state of this step; only one item may be in_progress. cancelled drops a step that will not be done, with its reason."
})
const TodoReasonSchema = Schema.optionalKey(
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
    Schema.annotateEncoded({
      description: "Required with cancelled: why the step will not be done, up to 300 characters."
    })
  )
)
const TodoTextFieldSchema = Schema.optionalKey(
  TodoTextSchema.pipe(
    Schema.annotateEncoded({ description: "Concrete todo step, from 1 to 500 characters." })
  )
)
const ContentItemSchema = Schema.Struct({
  content: TodoTextSchema,
  status: TodoStatusSchema,
  reason: TodoReasonSchema
})
const TodoItemInputSchema = Schema.Struct({
  content: TodoTextFieldSchema,
  step: TodoTextFieldSchema,
  text: TodoTextFieldSchema,
  status: TodoStatusSchema,
  reason: TodoReasonSchema
})
  .check(
    Schema.makeFilter((item) =>
      [item.content, item.step, item.text].filter((field) => field !== undefined).length === 1
        ? undefined
        : { path: ["content"], issue: "Give the step text once, as content" }
    )
  )
  .pipe(
    Schema.decodeTo(
      ContentItemSchema,
      SchemaTransformation.transform({
        decode: ({ content, step, text, ...rest }) => ({
          ...rest,
          content: content ?? step ?? text ?? ""
        }),
        encode: (item) => item
      })
    )
  )

const TodoItemSchema = TodoItemInputSchema.check(
  Schema.makeFilter((item) => {
    if (item.status === "cancelled" && item.reason === undefined)
      return { path: ["reason"], issue: "A cancelled item needs its reason" }
    if (item.status !== "cancelled" && item.reason !== undefined)
      return { path: ["reason"], issue: "Only a cancelled item takes a reason" }
    return undefined
  })
)

const TodoUpdateParametersSchema = Schema.Struct({
  explanation: Schema.optionalKey(
    Schema.NullOr(Schema.Trim.check(Schema.isMaxLength(2_000))).annotate({
      description:
        "Optional concise reason for replacing the list; null clears the prior explanation."
    })
  ),
  items: Schema.Array(TodoItemSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(50))
    .annotate({
      description: "Complete replacement list of 1 to 50 steps, in intended execution order."
    })
}).check(
  Schema.makeFilter((input) =>
    input.items.filter((item) => item.status === "in_progress").length <= 1
      ? undefined
      : "At most one todo item can be in_progress"
  )
)

const todoFailure = (error: TodoStoreError): ToolExecutionError =>
  toolFailure(error, error.reason === "conflict" ? "Todo changed" : "Todo update failed")

const makeTodoTool = ({ store }: { readonly store: TodoStore["Service"] }): ServerTool =>
  defineServerTool({
    name: "todo_update",
    description: [
      "Replace the visible todo list for multi-step work.",
      "Keep at most one item in_progress and mark every item completed only after verification, or cancelled with a reason; an all-completed list retires the sidebar state."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(TodoUpdateParametersSchema),
    metadata: {
      display: { trail: "plan" },
      effect: "run_record",
      display_name: "Update Todos",
      kind: "todo",
      action: "write",
      approval_preview: "Update this chat's checklist.",
      source: "_todos",
      changes_state: true,
      concurrency_group: "session_todo",
      destructive: true,
      permissions: ["session"],
      idempotent: true,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const snapshot = await recordApplied(
        effects,
        Effect.runPromise(
          store
            .setAgent(ctx.run.sessionId, ctx.run.runId, ctx.toolCallId, {
              items: input.items,
              explanation: input.explanation ?? null
            })
            .pipe(Effect.mapError(todoFailure)),
          { signal: ctx.signal }
        )
      )
      const completed = snapshot.items.filter((item) => item.status === "completed").length
      return {
        result: "Todo list updated.",
        preview: `${completed}/${snapshot.items.length} done`,
        data: {
          items: snapshot.items,
          explanation: snapshot.explanation,
          retired: completed === snapshot.items.length
        },
        host: appliedReceipt(ctx, {
          kind: "target",
          resourceRef: `todos:${ctx.run.sessionId}`,
          domain: "resource",
          title: "To-dos"
        })
      }
    }
  })

export const todoTools = Effect.gen(function* () {
  return [makeTodoTool({ store: yield* TodoStore })]
})
