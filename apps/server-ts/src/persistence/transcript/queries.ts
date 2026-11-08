import { storeReasons } from "../errors.js"
import { Context, Effect, Schema } from "effect"
import type { RunOrigin } from "@arden-hq/protocol/runs"
import type { TurnToolCallCount } from "@arden-hq/protocol/chat"
import type {
  StoredMessageEnvelope,
  TranscriptMessageRecord,
  TranscriptPage,
  TranscriptPageQuery,
  TranscriptSearchInput,
  TranscriptSearchPage,
  TranscriptTurnWorkPageQuery
} from "./model.js"

export class TranscriptQueryError extends Schema.TaggedError<TranscriptQueryError>()(
  "TranscriptQueryError",
  {
    reason: Schema.tag("storage"),
    operation: Schema.Literals(["resolve", "page"] as const),
    sessionId: Schema.NonEmptyString,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class TranscriptDataCorruptionError extends Schema.TaggedError<TranscriptDataCorruptionError>()(
  "TranscriptDataCorruptionError",
  {
    reason: Schema.tag("corrupt"),
    sessionId: Schema.NonEmptyString,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type TranscriptQueryFailure = TranscriptQueryError | TranscriptDataCorruptionError

export class TranscriptSearchError extends Schema.TaggedError<TranscriptSearchError>()(
  "TranscriptSearchError",
  {
    reason: storeReasons(["invalid", "not_found", "storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type TranscriptSearchFailure = TranscriptSearchError | TranscriptDataCorruptionError

export interface ConversationFindHit {
  readonly messageId: string
  readonly sequence: number
  readonly count: number
}

export interface ConversationFind {
  readonly hits: ReadonlyArray<ConversationFindHit>
  readonly truncated: boolean
}

interface ChatSearchHit {
  readonly sessionId: string
  readonly sessionName: string | null
  readonly messageId: string
  readonly createdAt: string
  readonly snippet: string
  readonly ranges: ReadonlyArray<readonly [start: number, end: number]>
}

export interface ChatSearchPage {
  readonly hits: ReadonlyArray<ChatSearchHit>
  readonly hasMore: boolean
}

export class TranscriptQueries extends Context.Service<
  TranscriptQueries,
  {
    readonly turnInputs: (input: {
      readonly sessionId: string
      readonly turnId: string
    }) => Effect.Effect<ReadonlyArray<StoredMessageEnvelope>, TranscriptQueryFailure>
    readonly ownerMessagesAfter: (input: {
      readonly sessionId: string
      readonly sequence: number
      readonly limit: number
    }) => Effect.Effect<ReadonlyArray<TranscriptMessageRecord>, TranscriptQueryFailure>
    readonly resolveReference: (
      sessionId: string,
      messageOrClientId: string
    ) => Effect.Effect<number | null, TranscriptQueryFailure>
    readonly page: (
      query: TranscriptPageQuery
    ) => Effect.Effect<TranscriptPage, TranscriptQueryFailure>
    readonly resolveConversationReference: (
      sessionId: string,
      messageOrClientId: string
    ) => Effect.Effect<number | null, TranscriptQueryFailure>
    readonly conversationPage: (
      query: TranscriptPageQuery
    ) => Effect.Effect<TranscriptPage, TranscriptQueryFailure>
    readonly resolveTurnWorkReference: (
      sessionId: string,
      turnId: string,
      messageId: string
    ) => Effect.Effect<number | null, TranscriptQueryFailure>
    readonly turnWorkPage: (
      query: TranscriptTurnWorkPageQuery
    ) => Effect.Effect<TranscriptPage, TranscriptQueryFailure>
    readonly toolCallCarrier: (
      sessionId: string,
      turnId: string,
      toolCallId: string
    ) => Effect.Effect<TranscriptMessageRecord | null, TranscriptQueryFailure>
    readonly toolResultsFor: (
      sessionId: string,
      turnIds: ReadonlyArray<string>,
      toolCallIds: ReadonlyArray<string>,
      view?: "full" | "compact"
    ) => Effect.Effect<ReadonlyArray<TranscriptMessageRecord>, TranscriptQueryFailure>
    readonly toolResultInSession: (
      sessionId: string,
      toolCallId: string
    ) => Effect.Effect<TranscriptMessageRecord | null, TranscriptQueryFailure>
    readonly turnIdsWithWork: (
      sessionId: string,
      turnIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlySet<string>, TranscriptQueryFailure>
    readonly turnIdsWithToolWork: (
      sessionId: string,
      turnIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlySet<string>, TranscriptQueryFailure>
    readonly toolCallCounts: (
      sessionId: string,
      turnIds: ReadonlyArray<string>
    ) => Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<TurnToolCallCount>>,
      TranscriptQueryFailure
    >
    readonly originsForTurns: (
      sessionId: string,
      turnIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyMap<string, RunOrigin>, TranscriptQueryFailure>
    readonly search: (
      input: TranscriptSearchInput
    ) => Effect.Effect<TranscriptSearchPage, TranscriptSearchFailure>
    readonly findInConversation: (
      sessionId: string,
      query: string
    ) => Effect.Effect<ConversationFind, TranscriptQueryFailure>
    readonly searchChats: (input: {
      readonly query: string
      readonly limit: number
    }) => Effect.Effect<ChatSearchPage, TranscriptSearchFailure>
  }
>()("@arden-hq/server/persistence/transcript/TranscriptQueries") {}
