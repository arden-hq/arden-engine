import { Schema, type Effect, type Scope, type Stream } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { JournalAppendResult, JournalDelivery, JournalEvent, JournalRecord } from "../types.js"

export type JournalOperation = "initialize" | "append" | "read" | "follow" | "retain"

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  operation: Schema.Literals(["initialize", "append", "read", "follow", "retain"] as const),
  kind: Schema.Literals(["invalid_input", "storage", "corrupt_data"] as const),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export const journalError = (
  operation: JournalOperation,
  kind: "invalid_input" | "storage" | "corrupt_data",
  message: string,
  cause?: unknown
): JournalError =>
  new JournalError({
    operation,
    kind,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export interface JournalWatermarks {
  readonly headSequence: number
  readonly retainedFromSequence: number | null
}

export interface JournalReadPage {
  readonly streamId: string
  readonly afterSequence: number
  readonly throughSequence: number
  readonly limit?: number
}

export const JOURNAL_START_AT = { beginning: "beginning", latest: "latest" } as const
export type JournalStartAt = (typeof JOURNAL_START_AT)[keyof typeof JOURNAL_START_AT]
const JOURNAL_START_ATS: ReadonlySet<string> = new Set<JournalStartAt>(
  Object.values(JOURNAL_START_AT)
)
export const isJournalStartAt = (value: string): value is JournalStartAt =>
  JOURNAL_START_ATS.has(value)

export interface JournalFollowInput {
  readonly streamId: string
  readonly afterSequence?: number
  readonly startAt?: JournalStartAt
  readonly replayFloor?: number
}

export interface JournalRuntimeOptions {
  readonly initialize?: boolean
  readonly subscriberCapacity?: number
  readonly subscriberByteCapacity?: number
  readonly reader?: SqlClient.SqlClient
}

export interface OpenJournalFollow {
  readonly initialSequence: number
  readonly stream: Stream.Stream<JournalDelivery, JournalError>
}

export interface JournalRuntime {
  readonly append: (
    streamId: string,
    events: ReadonlyArray<JournalEvent>
  ) => Effect.Effect<JournalAppendResult, JournalError>
  readonly notify: (committed: JournalAppendResult) => Effect.Effect<void>
  readonly watermarks: (streamId: string) => Effect.Effect<JournalWatermarks, JournalError>
  readonly readPage: (
    input: JournalReadPage
  ) => Effect.Effect<ReadonlyArray<JournalRecord>, JournalError>
  readonly openFollow: (
    input: JournalFollowInput
  ) => Effect.Effect<OpenJournalFollow, JournalError, Scope.Scope>
  readonly follow: (input: JournalFollowInput) => Stream.Stream<JournalDelivery, JournalError>
}
