import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { JournalRecord, JsonValue } from "../types.js"
import {
  JournalError,
  journalError,
  type JournalOperation,
  type JournalWatermarks
} from "./contracts.js"

export const PAGE_SIZE = 512
export const DEFAULT_SUBSCRIBER_CAPACITY = 4_096
export const DEFAULT_SUBSCRIBER_BYTES = 8 * 1024 * 1024

export const decodeJsonData = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const JsonAttributes = Schema.Record(Schema.String, Schema.Json)
export const decodeJsonAttributes = Schema.decodeUnknownSync(Schema.fromJsonString(JsonAttributes))
const NonEmptyText = Schema.String.check(Schema.isMinLength(1))
const EventSchema = Schema.Struct({
  type: NonEmptyText,
  data: Schema.Json,
  attributes: Schema.optionalKey(JsonAttributes),
  durable: Schema.optionalKey(Schema.Boolean)
})
export const EventBatchSchema = Schema.Array(EventSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((events) => {
    let sawTransient = false
    const issues: Array<Schema.FilterIssue> = []
    for (const [index, event] of events.entries()) {
      if (event.durable === false) sawTransient = true
      else if (sawTransient) {
        issues.push({
          path: [index, "durable"],
          issue: "Durable records must precede live-only records"
        })
      }
    }
    return issues
  })
)

export interface StreamRow {
  readonly head_sequence: number
  readonly retained_from_sequence: number | null
}

export interface RecordRow {
  readonly stream_id: string
  readonly sequence: number
  readonly event_type: string
  readonly data_json: string
  readonly attributes_json: string
  readonly created_at: string
}

export const validateCursor = (
  value: number,
  operation: JournalOperation,
  label: string
): Effect.Effect<number, JournalError> =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
        journalError(operation, "invalid_input", `${label} must be a non-negative safe integer`)
      )

export const validateStreamId = (
  streamId: string,
  operation: JournalOperation
): Effect.Effect<string, JournalError> =>
  typeof streamId === "string" && streamId.length > 0
    ? Effect.succeed(streamId)
    : Effect.fail(journalError(operation, "invalid_input", "streamId must be a non-empty string"))

const freezeJson = <A extends JsonValue | Readonly<Record<string, JsonValue>>>(value: A): A => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) freezeJson(nested)
  return Object.freeze(value)
}

export const freezeRecord = (record: JournalRecord): JournalRecord =>
  Object.freeze({
    ...record,
    data: freezeJson(record.data),
    attributes: freezeJson(record.attributes)
  })

export const readState = Effect.fn("Journal.readState")(function* (
  sql: SqlClient.SqlClient,
  streamId: string,
  operation: "append" | "read" | "follow"
): Effect.fn.Return<JournalWatermarks, JournalError> {
  const rows = yield* sql<StreamRow>`
    SELECT head_sequence, retained_from_sequence
    FROM journal_streams
    WHERE stream_id = ${streamId}
  `.pipe(
    Effect.mapError((cause) =>
      journalError(operation, "storage", "Could not read journal stream", cause)
    )
  )
  const row = rows[0]
  return row === undefined
    ? { headSequence: 0, retainedFromSequence: null }
    : { headSequence: row.head_sequence, retainedFromSequence: row.retained_from_sequence }
})

export const decodeRow = (
  row: RecordRow,
  operation: "read" | "follow"
): Effect.Effect<JournalRecord, JournalError> =>
  Effect.try({
    try: () => {
      const data = decodeJsonData(row.data_json)
      const attributes = decodeJsonAttributes(row.attributes_json)
      if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.event_type.length === 0)
        throw new Error("Invalid journal record fields")
      if (Number.isNaN(Date.parse(row.created_at))) throw new Error("Invalid journal timestamp")
      return freezeRecord({
        streamId: row.stream_id,
        sequence: row.sequence,
        type: row.event_type,
        data,
        attributes,
        durable: true,
        createdAt: row.created_at
      })
    },
    catch: (cause) =>
      journalError(operation, "corrupt_data", "Stored journal record is corrupt", cause)
  })
