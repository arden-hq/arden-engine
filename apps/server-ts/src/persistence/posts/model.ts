import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import {
  NewTaskInputSchema,
  SpaceTaskCaptureInputSchema,
  SpaceTaskSourceSchema
} from "@arden-hq/protocol/effect/spaces/work"
import { Schema } from "effect"

export const POST_TEXT_MAX = 1_500
export const POST_TASK_TITLE_MAX = 200
export const POST_TASK_BRIEF_MAX = 2_000

export const PostTaskSchema = Schema.Struct({
  title: NewTaskInputSchema.fields.text.check(Schema.isMaxLength(POST_TASK_TITLE_MAX)),
  brief: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(POST_TASK_BRIEF_MAX))
})
export type PostTask = typeof PostTaskSchema.Type

export const PostTextSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(POST_TEXT_MAX)
)

export const POST_WITHDRAWAL_REASONS = [
  "destination_archived",
  "destination_deleted",
  "undecodable",
  "undeliverable"
] as const

export const PostDeliveryPayloadSchema = Schema.Struct({
  kind: Schema.Literal("post"),
  automationId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  text: PostTextSchema,
  itemIds: Schema.Array(Schema.NonEmptyString),
  task: Schema.optionalKey(PostTaskSchema),
  withdrawal: Schema.optionalKey(
    Schema.Struct({
      at: IsoDateTimeStringSchema,
      reason: Schema.Literals(POST_WITHDRAWAL_REASONS)
    })
  )
})
export type PostDeliveryPayload = typeof PostDeliveryPayloadSchema.Type

export const postTaskParts = (payload: PostDeliveryPayload, task: PostTask) => ({
  input: { text: task.title, body: task.brief },
  taskSources: [
    {
      kind: "chat" as const,
      session_id: payload.sessionId,
      turn_id: payload.messageId,
      revision: payload.messageId
    },
    ...payload.itemIds.map((itemId) => ({
      kind: "connection_item" as const,
      item_id: itemId,
      revision: itemId
    }))
  ],
  capture: { basis: "explicit" as const, reason: payload.text }
})

export const PostTaskPartsSchema = Schema.Struct({
  input: NewTaskInputSchema,
  taskSources: Schema.Array(SpaceTaskSourceSchema),
  capture: SpaceTaskCaptureInputSchema
})
