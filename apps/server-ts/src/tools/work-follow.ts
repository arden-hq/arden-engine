import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import { toolFailure } from "./tool-failure.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt } from "./call-receipt.js"

const failure = (error: WorkStoreError): ToolExecutionError => toolFailure(error, "Task not moved")

const makeTaskMoveHereTool = ({ work }: { readonly work: WorkStore["Service"] }): ServerTool =>
  defineServerTool({
    name: "task_move_here",
    description:
      "Move an existing Task to the current chat when the user asks for its updates, questions or results here instead of where it is. The Task then belongs to this chat: everything it asks or reports comes here, and it works here when it runs in a chat. It keeps its Space and keeps working as before. Mentioning or linking a Task is not a request to move it.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        item_id: Schema.NonEmptyString.annotate({
          description: "Exact item_id returned by space_board_read for the existing Task."
        })
      })
    ),
    metadata: {
      effect: "arden_db",
      display_name: "Move Task here",
      kind: "tool",
      action: "write",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      concurrency_group: "space_work",
      approval_preview: "Move the Task to this chat."
    },
    execute: async (input, ctx, effects) => {
      const page = await Effect.runPromise(
        work.page({ itemId: input.item_id }).pipe(Effect.mapError(failure)),
        { signal: ctx.signal }
      )
      const task = page.items.find((item) => item.item_id === input.item_id)
      if (task === undefined)
        throw new ToolExecutionError("Read the current Task before moving it.", {
          preview: "Task unavailable",
          retryable: false
        })
      await recordApplied(
        effects,
        Effect.runPromise(
          work
            .moveToChat({ itemId: task.item_id, sessionId: ctx.run.sessionId })
            .pipe(Effect.mapError(failure)),
          { signal: ctx.signal }
        )
      )
      const label = task.text.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")
      const taskUrl = `arden:task/${encodeURIComponent(task.item_id)}`
      return {
        result: `Moved [${label}](${taskUrl}) to this chat.`,
        preview: "Task moved here",
        data: { task_url: taskUrl },
        host: appliedReceipt(ctx, {
          kind: "target",
          resourceRef: `task:${task.item_id}`,
          domain: "task",
          title: task.text,
          href: taskUrl
        })
      }
    }
  })

export const workFollowTools = Effect.gen(function* () {
  return [makeTaskMoveHereTool({ work: yield* WorkStore })]
})
