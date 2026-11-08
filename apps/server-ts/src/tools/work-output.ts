import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { taskFileHref, WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import { toolFailure } from "./tool-failure.js"
import { appliedReceipt } from "./call-receipt.js"
import { sha256Hex } from "@arden-hq/std/hash"

const failure = (error: WorkStoreError): ToolExecutionError =>
  toolFailure(error, "Task report not saved")

const makeWorkOutputTool = ({ work }: { readonly work: WorkStore["Service"] }): ServerTool =>
  defineServerTool({
    name: "task_save_result",
    description:
      "Save a named Markdown report in the Task's Files so the user can open the complete result. This works without a Local folder or permission to edit Memory. Save the actual deliverable here when no other authorized destination is available. This does not mark the Task done or claim that a requested external write succeeded. Use the returned attachment_id as completion evidence. Repeating the same Task, name and content reuses the saved report.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        item_id: Schema.NonEmptyString.annotate({
          description: "Exact item_id of the Task returned by space_board_read."
        }),
        name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(255)).pipe(
          Schema.annotateEncoded({
            description: "Short descriptive Markdown filename, for example role-fit-brief.md."
          })
        ),
        content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500_000)).annotate({
          description:
            "The complete Markdown deliverable, with named evidence links. Include limitations and remaining work."
        })
      })
    ),
    metadata: {
      effect: "arden_db",
      scopes: ["worker", "observer", "agent_research", "agent_code"],
      display_name: "Save Task report",
      kind: "tool",
      action: "write",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      concurrency_group: "space_work",
      approval_preview: "Save a report in this Task's Files."
    },
    execute: async (input, ctx, effects) => {
      if (input.content.trim().length === 0)
        throw new ToolExecutionError("The report must contain the actual result", {
          preview: "Empty report",
          retryable: false
        })
      const page = await Effect.runPromise(
        work.page({ itemId: input.item_id }).pipe(Effect.mapError(failure)),
        { signal: ctx.signal }
      )
      const task = page.items.find((item) => item.item_id === input.item_id)
      if (task === undefined)
        throw new ToolExecutionError(
          "Task not found. Read the current Task before saving its report.",
          { preview: "Task unavailable", retryable: false }
        )
      const data = new TextEncoder().encode(input.content)
      const attachment = await Effect.runPromise(
        work
          .createAttachment(
            { kind: "item", itemId: task.item_id },
            { name: input.name, media_type: "text/markdown", data },
            ctx.run.runId
          )
          .pipe(Effect.mapError(failure)),
        { signal: ctx.signal }
      )
      const saved = !page.attachments.some(
        (existing) => existing.attachment_id === attachment.attachment_id
      )
      if (saved) effects.applied()
      else effects.unchanged()
      const label = task.text.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")
      const taskUrl = `arden:task/${encodeURIComponent(task.item_id)}`
      const fileUrl = taskFileHref(task.item_id, attachment.attachment_id)
      const fileName = attachment.name.replace(/[\\[\]]/g, "\\$&")
      return {
        result: `Saved [${fileName}](${fileUrl}) in [${label}](${taskUrl}) with attachment ID ${attachment.attachment_id}. Link the report as [report](${fileUrl}), never through the Task link. The Task remains ${task.status}; when the requested outcome is achieved, use completion evidence {"kind":"attachment","attachment_id":${attachment.attachment_id},"description":"what this file proves"}.`,
        preview: attachment.name,
        data: {
          attachment_id: attachment.attachment_id,
          task_url: taskUrl,
          file_url: fileUrl,
          attachment
        },
        ...(saved
          ? {
              host: appliedReceipt(ctx, {
                kind: "versioned_resource",
                resourceRef: `task_file:${attachment.attachment_id}`,
                beforeVersion: "absent",
                afterVersion: sha256Hex(data),
                domain: "file",
                title: attachment.name,
                href: fileUrl
              })
            }
          : {})
      }
    }
  })

export const workOutputTools = Effect.gen(function* () {
  return [makeWorkOutputTool({ work: yield* WorkStore })]
})
