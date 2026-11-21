import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import { NewTaskInputSchema } from "@arden-hq/protocol/effect/spaces/work"
import { Schema } from "effect"

const POST_TEXT_MAX = 1_500
const POST_TASK_TITLE_MAX = 200
const POST_TASK_BRIEF_MAX = 2_000

const PostTaskSchema = Schema.Struct({
  title: NewTaskInputSchema.fields.text.check(Schema.isMaxLength(POST_TASK_TITLE_MAX)),
  brief: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(POST_TASK_BRIEF_MAX))
})
export type PostTask = typeof PostTaskSchema.Type

const PostTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(POST_TEXT_MAX))

export const POST_WITHDRAWAL_REASONS = [
  "destination_archived",
  "destination_deleted",
  "undecodable"
] as const

export const PostDeliveryPayloadSchema = Schema.Struct({
  kind: Schema.Literal("post"),
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  text: PostTextSchema,
  replyToMessageId: Schema.optionalKey(Schema.NonEmptyString),
  task: Schema.optionalKey(
    Schema.Struct({
      ...PostTaskSchema.fields,
      itemIds: Schema.Array(Schema.NonEmptyString)
    })
  ),
  withdrawal: Schema.optionalKey(
    Schema.Struct({
      at: IsoDateTimeStringSchema,
      reason: Schema.Literals(POST_WITHDRAWAL_REASONS)
    })
  )
})
export type PostDeliveryPayload = typeof PostDeliveryPayloadSchema.Type
