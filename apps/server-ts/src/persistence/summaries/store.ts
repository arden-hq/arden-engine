import { Context, Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

export class SummaryStoreError extends Schema.TaggedError<SummaryStoreError>()(
  "SummaryStoreError",
  {
    ...storeErrorFields({
      operations: ["set_chat", "chat", "space_chats"],
      reasons: ["storage"]
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
    }) => Effect.Effect<boolean, SummaryStoreError>
    readonly chat: (sessionId: string) => Effect.Effect<ChatSummary | null, SummaryStoreError>
    readonly chats: (
      sessionIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyMap<string, ChatSummary>, SummaryStoreError>
    readonly spaceChats: (
      spaceId: string
    ) => Effect.Effect<ReadonlyArray<ChatSummary>, SummaryStoreError>
  }
>()("@arden-hq/server/persistence/summaries/SummaryStore") {}
