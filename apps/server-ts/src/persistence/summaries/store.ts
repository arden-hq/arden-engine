import { Context, Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

export class SummaryStoreError extends Schema.TaggedError<SummaryStoreError>()(
  "SummaryStoreError",
  {
    ...storeErrorFields({
      operations: [
        "set_chat",
        "chat",
        "space_chats",
        "overview_input",
        "set_space",
        "space",
        "space_history"
      ],
      reasons: ["invalid", "not_found", "storage"]
    })
  }
) {}

export interface ChatSummary {
  readonly sessionId: string
  readonly publicRef: string
  readonly chatName: string | null
  readonly spaceId: string | null
  readonly lastActivity: string
  readonly title: string
  readonly summary: string
  readonly topics: ReadonlyArray<string>
  readonly throughSequence: number
  readonly runId: string | null
  readonly updatedAt: string
}

export interface SpaceSummary {
  readonly spaceId: string
  readonly now: string
  readonly next: ReadonlyArray<string>
  readonly recent: string | null
  readonly sourcesFingerprint: string
  readonly updatedAt: string
  readonly revisionId: number | null
  readonly sourceFreshness: "fresh" | "stale" | "unknown"
  readonly systemPromptHash: string | null
  readonly userPrompt: string | null
}

export interface SpaceOverviewInput {
  readonly spaceName: string
  readonly chats: ReadonlyArray<ChatSummary>
  readonly fingerprint: string
}

const SpaceOverviewRevisionSchema = Schema.Struct({
  revisionId: Schema.Int,
  spaceId: Schema.String,
  kind: Schema.Literals(["baseline", "generated"]),
  now: Schema.String,
  next: Schema.Array(Schema.String),
  recent: Schema.NullOr(Schema.String),
  sourcesFingerprint: Schema.String,
  sourceRefs: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        sessionId: Schema.String,
        throughSequence: Schema.Int,
        runId: Schema.NullOr(Schema.String)
      })
    )
  ),
  userPrompt: Schema.NullOr(Schema.String),
  systemPromptHash: Schema.NullOr(Schema.String),
  triggerAutomationRunId: Schema.NullOr(Schema.Int),
  triggerChatRunId: Schema.NullOr(Schema.String),
  generatedAt: Schema.String,
  recordedAt: Schema.String
})
export type SpaceOverviewRevision = typeof SpaceOverviewRevisionSchema.Type

export const SpaceOverviewHistoryQuerySchema = Schema.Struct({
  after: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  ),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
  )
})
export const SpaceOverviewHistoryPageSchema = Schema.Struct({
  entries: Schema.Array(SpaceOverviewRevisionSchema),
  next_after_revision: Schema.NullOr(Schema.Int),
  coverage: Schema.Literals(["from_creation", "from_baseline", "pending_baseline"])
})
export type SpaceOverviewHistoryPage = typeof SpaceOverviewHistoryPageSchema.Type

export class SummaryStore extends Context.Service<
  SummaryStore,
  {
    readonly setChat: (input: {
      readonly sessionId: string
      readonly title: string
      readonly summary: string
      readonly topics: ReadonlyArray<string>
      readonly throughSequence: number
      readonly runId: string | null
    }) => Effect.Effect<void, SummaryStoreError>
    readonly chat: (sessionId: string) => Effect.Effect<ChatSummary | null, SummaryStoreError>
    readonly chats: (
      sessionIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyMap<string, ChatSummary>, SummaryStoreError>
    readonly spaceChats: (
      spaceId: string
    ) => Effect.Effect<ReadonlyArray<ChatSummary>, SummaryStoreError>
    readonly overviewInput: (
      spaceId: string
    ) => Effect.Effect<SpaceOverviewInput | null, SummaryStoreError>
    readonly setSpace: (input: {
      readonly spaceId: string
      readonly now: string
      readonly next: ReadonlyArray<string>
      readonly recent: string | null
      readonly sourcesFingerprint: string
      readonly expectedRevisionId: number | null
      readonly userPrompt: string
      readonly systemPromptHash: string
      readonly triggerAutomationRunId: number | null
      readonly triggerChatRunId: string | null
    }) => Effect.Effect<boolean, SummaryStoreError>
    readonly space: (spaceId: string) => Effect.Effect<SpaceSummary | null, SummaryStoreError>
    readonly spaceHistory: (
      spaceId: string,
      after: number,
      limit: number
    ) => Effect.Effect<SpaceOverviewHistoryPage, SummaryStoreError>
  }
>()("@arden-hq/server/persistence/summaries/SummaryStore") {}
