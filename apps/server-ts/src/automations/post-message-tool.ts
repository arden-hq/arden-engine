import { createTool, createToolset, type Toolset } from "@arden-hq/loop"
import { Schema } from "effect"
import { TOOL_DISPLAY_TITLE } from "../execution/tool-call-presentation.js"
import { mergeToolsets } from "../execution/toolset-middleware.js"
import type { HandlerToolName } from "../persistence/automations/queue.js"
import {
  POST_TASK_BRIEF_MAX,
  POST_TASK_TITLE_MAX,
  POST_TEXT_MAX,
  PostTaskSchema,
  PostTextSchema
} from "../persistence/posts/model.js"

export const POST_MESSAGE_TOOL = "post_message" satisfies HandlerToolName

export const PostMessageInputSchema = Schema.Struct({
  space_id: Schema.NonEmptyString.annotate({
    description: "The exact Space id from space_list."
  }).pipe(Schema.optionalKey),
  text: Schema.String.check(Schema.isMaxLength(POST_TEXT_MAX))
    .annotate({ description: "The message, in Markdown." })
    .pipe(Schema.decodeTo(PostTextSchema)),
  task: Schema.Struct({
    title: Schema.String.check(Schema.isMaxLength(POST_TASK_TITLE_MAX))
      .annotate({ description: "A short name for the work." })
      .pipe(Schema.decodeTo(PostTaskSchema.fields.title)),
    brief: Schema.String.check(Schema.isMaxLength(POST_TASK_BRIEF_MAX))
      .annotate({ description: "What Arden should do, and what it needs for it." })
      .pipe(Schema.decodeTo(PostTaskSchema.fields.brief))
  })
    .annotate({ description: "Work Arden can do about it." })
    .pipe(Schema.optionalKey)
})
export type PostMessageInput = typeof PostMessageInputSchema.Type

const tool = createTool({
  name: POST_MESSAGE_TOOL,
  description:
    "Post one message to the user in a Space's chat. Say what arrived, from whom, what they need to do and by when, in two or three sentences, with a link to the source. Leave space_id out if no Space fits. Add task only for work Arden can do.",
  parameters: Schema.toStandardSchemaV1(PostMessageInputSchema),
  metadata: {
    display_name: "Post a message",
    kind: "tool",
    action: "write",
    source: "_events",
    changes_state: false,
    concurrency_group: null,
    destructive: false,
    default_approval: "approve",
    internal_catalog: true,
    ends_turn: true
  },
  execute: async (input) => ({
    result: JSON.stringify(input),
    preview: "Message ready",
    data: { post: input }
  })
})

const bindPostToolset = createToolset([tool], {
  toJsonSchema: (schema: Schema.Constraint): Record<string, unknown> =>
    Schema.toJsonSchemaDocument(schema).schema,
  displayTitle: TOOL_DISPLAY_TITLE
})

export const withPostMessageTool = (base: Toolset): Toolset =>
  mergeToolsets(base, { toolset: bindPostToolset(undefined), names: new Set([POST_MESSAGE_TOOL]) })
