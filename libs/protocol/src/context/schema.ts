import { Schema } from "effect"
import { withExtras, NonNegativeIntSchema } from "../common/schema.js"

const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1))

export const CONTEXT_COMPACTION_STATUS = {
  noSession: "no_session",
  nothingToCompact: "nothing_to_compact",
  compacted: "compacted"
} as const

export type ContextCompactionStatus =
  (typeof CONTEXT_COMPACTION_STATUS)[keyof typeof CONTEXT_COMPACTION_STATUS]

const NoSessionCompactionResponseSchema = withExtras({
  status: Schema.Literal(CONTEXT_COMPACTION_STATUS.noSession),
  message: Schema.String
})

const NothingToCompactResponseSchema = withExtras({
  status: Schema.Literal(CONTEXT_COMPACTION_STATUS.nothingToCompact),
  message: Schema.String,
  message_count: NonNegativeIntSchema
})

const CompactedContextResponseSchema = withExtras({
  status: Schema.Literal(CONTEXT_COMPACTION_STATUS.compacted),
  message: Schema.String,
  before_messages: NonNegativeIntSchema,
  after_messages: NonNegativeIntSchema,
  messages_compressed: NonNegativeIntSchema
}).check(
  Schema.makeFilter((outcome) => {
    if (outcome.after_messages > outcome.before_messages) {
      return { path: ["after_messages"], issue: "must not exceed before_messages" }
    }
    return outcome.messages_compressed <= outcome.before_messages
      ? undefined
      : { path: ["messages_compressed"], issue: "must not exceed before_messages" }
  })
)

export const ContextCompactionResponseSchema = Schema.Union([
  NoSessionCompactionResponseSchema,
  NothingToCompactResponseSchema,
  CompactedContextResponseSchema
])

export type ContextCompactionResponse = typeof ContextCompactionResponseSchema.Type

export const ContextCompactionRequestSchema = Schema.Struct({
  session_id: NonEmptyTextSchema
})
