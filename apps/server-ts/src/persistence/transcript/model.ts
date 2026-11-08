import { DateTime, Option, Schema } from "effect"
import { JsonObjectSchema } from "../json.js"

export const TRANSCRIPT_RESULT_PREVIEW_CHARS = 240

export const SESSION_HANDOFF_MARKER = "[Session State Handoff]"

const UniqueNonEmptyStringsSchema = Schema.Array(Schema.NonEmptyString).check(Schema.isUnique())
const jsonEquivalent = Schema.toEquivalence(Schema.Json)

export const MessageRoleSchema = Schema.Literals([
  "system",
  "developer",
  "user",
  "assistant",
  "tool"
] as const)

const decodeTimestamp = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)
const hasExplicitTimeZone = (value: string): boolean => {
  const time = value.indexOf("T")
  if (time < 0) return false
  const suffix = value.slice(time + 1)
  return suffix.endsWith("Z") || suffix.includes("+") || suffix.includes("-")
}
const StoredTimestampSchema = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    hasExplicitTimeZone(value) && Option.isSome(decodeTimestamp(value))
      ? undefined
      : { path: [], issue: "must be an ISO timestamp with an explicit time zone" }
  )
)

export const StoredMessageEnvelopeSchema = Schema.StructWithRest(
  Schema.Struct({
    message_id: Schema.NonEmptyString,
    role: MessageRoleSchema,
    created_at: StoredTimestampSchema,
    client_id: Schema.optionalKey(Schema.NonEmptyString),
    turn_id: Schema.optionalKey(Schema.NonEmptyString),
    applied_at: Schema.optionalKey(StoredTimestampSchema),
    superseded: Schema.optionalKey(Schema.Literal(true))
  }),
  [Schema.Record(Schema.String, Schema.Json)]
)

export type StoredMessageEnvelope = (typeof StoredMessageEnvelopeSchema)["Type"]

export const visibleMessageCount = (messages: ReadonlyArray<StoredMessageEnvelope>): number =>
  messages.filter(
    (message) =>
      message.role !== "system" &&
      message.role !== "developer" &&
      typeof message.forked_from !== "string"
  ).length

export const withoutTurnStamp = (message: StoredMessageEnvelope): StoredMessageEnvelope => {
  const { turn_id: _turnId, ...bare } = message
  return bare
}

const sameOptionalStrings = (
  actual: unknown,
  expected: ReadonlyArray<string> | undefined
): boolean =>
  expected === undefined
    ? actual === undefined
    : Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])

const CompactionReceiptDraftSchema = Schema.Struct({
  compactionId: Schema.NonEmptyString,
  kind: Schema.Literal("session_handoff"),
  messageStart: Schema.optionalKey(Schema.Natural),
  messageEnd: Schema.optionalKey(Schema.Natural),
  messageStartId: Schema.optionalKey(Schema.NonEmptyString),
  messageEndId: Schema.optionalKey(Schema.NonEmptyString),
  parentCompactionId: Schema.optionalKey(Schema.NonEmptyString),
  reason: Schema.optionalKey(Schema.NonEmptyString),
  messagesBefore: Schema.Natural,
  messagesAfter: Schema.Natural,
  preservedTailIds: UniqueNonEmptyStringsSchema,
  toolResultRefs: Schema.optionalKey(UniqueNonEmptyStringsSchema),
  backgroundResultRefs: Schema.optionalKey(UniqueNonEmptyStringsSchema),
  rehydrationState: Schema.NullOr(JsonObjectSchema)
})

const TranscriptMessageDraftFields = Schema.Struct({
  messageId: Schema.NonEmptyString,
  role: MessageRoleSchema,
  envelope: StoredMessageEnvelopeSchema,
  clientId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.DateTimeUtc,
  searchText: Schema.NullOr(Schema.String),
  compaction: Schema.NullOr(CompactionReceiptDraftSchema)
})

export const TranscriptMessageDraftSchema = TranscriptMessageDraftFields.check(
  Schema.makeFilter((message) => {
    const issues: Array<Schema.FilterIssue> = []
    if (message.envelope.message_id !== message.messageId) {
      issues.push({ path: ["envelope", "message_id"], issue: "must equal messageId" })
    }
    if (message.envelope.role !== message.role) {
      issues.push({ path: ["envelope", "role"], issue: "must equal role" })
    }
    const envelopeTime = decodeTimestamp(message.envelope.created_at)
    if (
      Option.isNone(envelopeTime) ||
      !DateTime.Equivalence(envelopeTime.value, message.createdAt)
    ) {
      issues.push({ path: ["envelope", "created_at"], issue: "must equal createdAt" })
    }
    if ((message.envelope.client_id ?? null) !== message.clientId) {
      issues.push({ path: ["envelope", "client_id"], issue: "must equal clientId" })
    }

    const receipt = message.compaction
    const encoded = message.envelope.compaction
    const encodedReceipt =
      typeof encoded === "object" && encoded !== null && !Array.isArray(encoded)
        ? (encoded as Readonly<Record<string, Schema.Json | undefined>>)
        : null
    if (receipt !== null) {
      if (message.role !== "assistant") {
        issues.push({ path: ["role"], issue: "a session handoff must be an assistant message" })
      }
      if (receipt.compactionId !== message.messageId) {
        issues.push({ path: ["compaction", "compactionId"], issue: "must equal messageId" })
      }
      const content = message.envelope.content
      if (typeof content !== "string" || !content.startsWith(SESSION_HANDOFF_MARKER)) {
        issues.push({
          path: ["envelope", "content"],
          issue: `must start with ${SESSION_HANDOFF_MARKER}`
        })
      }
      if (encodedReceipt === null) {
        issues.push({ path: ["envelope", "compaction"], issue: "must be an object" })
      } else {
        if (
          encodedReceipt.compaction_id !== receipt.compactionId ||
          encodedReceipt.kind !== receipt.kind ||
          encodedReceipt.messages_before !== receipt.messagesBefore ||
          encodedReceipt.messages_after !== receipt.messagesAfter ||
          encodedReceipt.message_start !== receipt.messageStart ||
          encodedReceipt.message_end !== receipt.messageEnd ||
          encodedReceipt.message_start_id !== receipt.messageStartId ||
          encodedReceipt.message_end_id !== receipt.messageEndId ||
          encodedReceipt.parent_compaction_id !== receipt.parentCompactionId ||
          encodedReceipt.reason !== receipt.reason ||
          !sameOptionalStrings(encodedReceipt.preserved_tail_ids, receipt.preservedTailIds) ||
          !sameOptionalStrings(encodedReceipt.tool_result_refs, receipt.toolResultRefs) ||
          !sameOptionalStrings(
            encodedReceipt.background_result_refs,
            receipt.backgroundResultRefs
          ) ||
          !jsonEquivalent(encodedReceipt.rehydration ?? null, receipt.rehydrationState)
        ) {
          issues.push({ path: ["envelope", "compaction"], issue: "must match the receipt" })
        }
      }
    } else if (encodedReceipt?.kind === "session_handoff") {
      issues.push({ path: ["compaction"], issue: "is required for a session handoff" })
    }
    return issues
  })
)

export type TranscriptMessageDraft = (typeof TranscriptMessageDraftSchema)["Type"]

export const TranscriptMessageRecordSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  sequence: Schema.Natural,
  role: MessageRoleSchema,
  clientId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.DateTimeUtc,
  envelope: StoredMessageEnvelopeSchema
}).check(
  Schema.makeFilter((record) => {
    const issues: Array<Schema.FilterIssue> = []
    if (record.envelope.message_id !== record.messageId) {
      issues.push({ path: ["envelope", "message_id"], issue: "must equal messageId" })
    }
    if (record.envelope.role !== record.role) {
      issues.push({ path: ["envelope", "role"], issue: "must equal role" })
    }
    const envelopeTime = decodeTimestamp(record.envelope.created_at)
    if (
      Option.isNone(envelopeTime) ||
      !DateTime.Equivalence(envelopeTime.value, record.createdAt)
    ) {
      issues.push({ path: ["envelope", "created_at"], issue: "must equal createdAt" })
    }
    if ((record.envelope.client_id ?? null) !== record.clientId) {
      issues.push({ path: ["envelope", "client_id"], issue: "must equal clientId" })
    }
    return issues
  })
)

export type TranscriptMessageRecord = (typeof TranscriptMessageRecordSchema)["Type"]

const ASYNC_RESULT = "async-result:"
export const asyncResultClientId = (toolCallId: string): string => `${ASYNC_RESULT}${toolCallId}`

export const asToolResultRecord = (record: TranscriptMessageRecord): TranscriptMessageRecord => {
  if (record.role !== "user" || record.clientId?.startsWith(ASYNC_RESULT) !== true) return record
  const toolCallId = record.clientId.slice(ASYNC_RESULT.length)
  const content = record.envelope.content
  const block = Array.isArray(content)
    ? content.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          item.content_type === "async_tool_result"
      )
    : undefined
  const result =
    typeof block === "object" && block !== null && !Array.isArray(block) ? block.content : undefined
  const { is_meta: _meta, ...envelope } = record.envelope
  return {
    ...record,
    role: "tool",
    envelope: {
      ...envelope,
      role: "tool",
      tool_call_id: toolCallId,
      content: result ?? ""
    }
  }
}

const TranscriptPageFields = Schema.Struct({
  records: Schema.Array(TranscriptMessageRecordSchema),
  hasMoreBefore: Schema.Boolean,
  hasMoreAfter: Schema.Boolean,
  firstSequence: Schema.NullOr(Schema.Natural),
  lastSequence: Schema.NullOr(Schema.Natural)
})

export const TranscriptPageSchema = TranscriptPageFields.check(
  Schema.makeFilter((page) => {
    const issues: Array<Schema.FilterIssue> = []
    const sequences = page.records.map((record) => record.sequence)
    if (new Set(page.records.map((record) => record.sessionId)).size > 1) {
      issues.push({ path: ["records"], issue: "must belong to one session" })
    }
    if (new Set(page.records.map((record) => record.messageId)).size !== page.records.length) {
      issues.push({ path: ["records"], issue: "message ids must be unique" })
    }
    if (page.records.length === 0 && (page.hasMoreBefore || page.hasMoreAfter)) {
      issues.push({ path: ["records"], issue: "an empty page cannot advertise more records" })
    }
    if (
      sequences.some((sequence, index) => {
        const previous = sequences[index - 1]
        return previous !== undefined && sequence <= previous
      })
    ) {
      issues.push({ path: ["records"], issue: "sequences must be strictly increasing" })
    }
    const first = page.records[0]?.sequence ?? null
    const last = page.records[page.records.length - 1]?.sequence ?? null
    if (page.firstSequence !== first) {
      issues.push({ path: ["firstSequence"], issue: "must match the first record" })
    }
    if (page.lastSequence !== last) {
      issues.push({ path: ["lastSequence"], issue: "must match the last record" })
    }
    return issues
  })
)

export type TranscriptPage = (typeof TranscriptPageSchema)["Type"]

const TranscriptPageBase = {
  sessionId: Schema.NonEmptyString,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 250 }))
} as const

export const TranscriptPageQuerySchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Latest"), ...TranscriptPageBase }),
  Schema.Struct({
    _tag: Schema.Literal("Before"),
    ...TranscriptPageBase,
    sequence: Schema.Natural
  }),
  Schema.Struct({
    _tag: Schema.Literal("After"),
    ...TranscriptPageBase,
    sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))
  }),
  Schema.Struct({ _tag: Schema.Literal("Around"), ...TranscriptPageBase, sequence: Schema.Natural })
]).pipe(Schema.toTaggedUnion("_tag"))

export type TranscriptPageQuery = (typeof TranscriptPageQuerySchema)["Type"]

const TranscriptTurnWorkPageBase = {
  sessionId: Schema.NonEmptyString,
  turnId: Schema.NonEmptyString,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
} as const

export const TranscriptTurnWorkPageQuerySchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Latest"), ...TranscriptTurnWorkPageBase }),
  Schema.Struct({
    _tag: Schema.Literal("Before"),
    ...TranscriptTurnWorkPageBase,
    sequence: Schema.Natural
  }),
  Schema.Struct({
    _tag: Schema.Literal("After"),
    ...TranscriptTurnWorkPageBase,
    sequence: Schema.Natural
  })
]).pipe(Schema.toTaggedUnion("_tag"))

export type TranscriptTurnWorkPageQuery = (typeof TranscriptTurnWorkPageQuerySchema)["Type"]

const TranscriptSearchQueryTextSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500)
)

export const TranscriptSearchInputSchema = Schema.Struct({
  requestingSessionId: Schema.NonEmptyString,
  allSpaces: Schema.optionalKey(Schema.Boolean),
  query: TranscriptSearchQueryTextSchema,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  offset: Schema.Natural,
  sessionRef: Schema.optionalKey(Schema.NonEmptyString),
  since: Schema.optionalKey(StoredTimestampSchema)
})

export type TranscriptSearchInput = (typeof TranscriptSearchInputSchema)["Type"]

const TranscriptSearchHitSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  sessionRef: Schema.NonEmptyString,
  sessionName: Schema.NullOr(Schema.String),
  spaceName: Schema.optionalKey(Schema.String),
  messageId: Schema.NonEmptyString,
  sequence: Schema.Natural,
  role: MessageRoleSchema,
  createdAt: StoredTimestampSchema,
  snippet: Schema.String.check(Schema.isMaxLength(800)),
  matchCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})

export const TranscriptSearchPageSchema = Schema.Struct({
  hits: Schema.Array(TranscriptSearchHitSchema),
  hasMore: Schema.Boolean
})

export type TranscriptSearchPage = (typeof TranscriptSearchPageSchema)["Type"]
