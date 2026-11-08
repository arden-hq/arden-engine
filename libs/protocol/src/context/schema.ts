import { Effect, Schema } from "effect"
import { withExtras, NonNegativeIntSchema } from "../common/schema.js"
import type { ContextCompactionOutcome } from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1))
const NullableNonNegativeIntSchema = Schema.NullOr(NonNegativeIntSchema)

const NoSessionCompactionResponseSchema = withExtras({
  status: Schema.Literal("no_session"),
  message: Schema.String
})

const NothingToCompactResponseSchema = withExtras({
  status: Schema.Literal("nothing_to_compact"),
  message: Schema.String,
  message_count: NonNegativeIntSchema,
  before_tokens: NullableNonNegativeIntSchema
})

const AlreadyOptimalCompactionResponseSchema = withExtras({
  status: Schema.Literal("already_optimal"),
  message: Schema.String,
  message_count: NonNegativeIntSchema
})

const CompactedContextResponseSchema = withExtras({
  status: Schema.Literal("compacted"),
  message: Schema.String,
  before_tokens: NullableNonNegativeIntSchema,
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
  AlreadyOptimalCompactionResponseSchema,
  CompactedContextResponseSchema
])

export const OptionalSessionIdSchema = Schema.UndefinedOr(NonEmptyTextSchema)
export const ContextCompactionRequestSchema = Schema.Struct({
  session_id: Schema.optionalKey(NonEmptyTextSchema)
})

export const mapCompactionOutcome = (
  value: Schema.Schema.Type<typeof ContextCompactionResponseSchema>
): ContextCompactionOutcome => {
  switch (value.status) {
    case "no_session": {
      const { status: _status, message, ...extras } = value
      return { ...extras, status: "noSession", message }
    }
    case "nothing_to_compact": {
      const { status: _status, message, message_count, before_tokens, ...extras } = value
      return {
        ...extras,
        status: "nothingToCompact",
        message,
        messageCount: message_count,
        inputTokens: before_tokens
      }
    }
    case "already_optimal": {
      const { status: _status, message, message_count, ...extras } = value
      return { ...extras, status: "alreadyOptimal", message, messageCount: message_count }
    }
    case "compacted": {
      const {
        status: _status,
        message,
        before_tokens,
        before_messages,
        after_messages,
        messages_compressed,
        ...extras
      } = value
      return {
        ...extras,
        status: "compacted",
        message,
        inputTokens: before_tokens,
        beforeMessageCount: before_messages,
        afterMessageCount: after_messages,
        messagesCompressed: messages_compressed
      }
    }
  }
}

export const encodeContextCompactionRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(OptionalSessionIdSchema)(value, strict).pipe(
    Effect.map((sessionId) =>
      JSON.stringify(sessionId === undefined ? {} : { session_id: sessionId })
    )
  )
