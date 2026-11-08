import type { RunActivity } from "@arden-hq/protocol/chat"
import { Context, Effect, Schema, Scope, Stream } from "effect"
import type {
  CommitEventBatch,
  CommittedEventBatch,
  EventPage,
  EventWatermarks,
  SessionEventRecord
} from "./model.js"
import type { UnitOfWork } from "../unit-of-work.js"

export type ChatEventOperation = "append" | "read" | "follow" | "checkpoint"

export class ChatEventStoreError extends Schema.TaggedError<ChatEventStoreError>()(
  "ChatEventStoreError",
  {
    operation: Schema.Literals(["append", "read", "follow", "checkpoint"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class ChatEventPageOverflow extends Schema.TaggedError<ChatEventPageOverflow>()(
  "ChatEventPageOverflow",
  {
    sequence: Schema.Int,
    capacityBytes: Schema.Int
  }
) {}

export interface ReadChatEventPage {
  readonly sessionId: string
  readonly afterSequence: number
  readonly throughSequence: number
  readonly limit: number
  readonly capacityBytes?: number
}

export type ChatEventDelivery =
  | {
      readonly kind: "record"
      readonly record: SessionEventRecord
      readonly replayed: boolean
    }
  | {
      readonly kind: "reset"
      readonly reason: "future_cursor" | "replay_gap"
      readonly cursor: number
    }
  | {
      readonly kind: "overflow"
      readonly cursor: number
    }

export interface FollowChatEvents {
  readonly sessionId: string
  readonly afterSequence?: number
  readonly startAt?: "beginning" | "latest"
  readonly replayFloor?: number
}

export interface OpenChatEventFollow {
  readonly initialSequence: number
  readonly stream: Stream.Stream<ChatEventDelivery, ChatEventStoreError>
}

export type ChatActiveProjection =
  | {
      readonly kind: "complete"
      readonly records: ReadonlyArray<SessionEventRecord>
    }
  | {
      readonly kind: "overflow"
      readonly throughSequence: number
    }

export interface ReadChatActiveProjection {
  readonly sessionId: string
  readonly afterSequence: number
  readonly throughSequence: number
}

export class ChatEventStore extends Context.Service<
  ChatEventStore,
  {
    readonly currentActivity: (sessionId: string, runId: string) => RunActivity | undefined
    readonly append: (
      batch: CommitEventBatch
    ) => Effect.Effect<CommittedEventBatch, ChatEventStoreError>
    readonly appendInTransaction: (
      batch: CommitEventBatch
    ) => Effect.Effect<CommittedEventBatch, ChatEventStoreError, UnitOfWork>
    readonly setCheckpointInTransaction: (
      sessionId: string,
      sequence: number
    ) => Effect.Effect<void, ChatEventStoreError>
    readonly watermarks: (sessionId: string) => Effect.Effect<EventWatermarks, ChatEventStoreError>
    readonly readPage: (
      input: ReadChatEventPage
    ) => Effect.Effect<EventPage, ChatEventStoreError | ChatEventPageOverflow>
    readonly openFollow: (
      input: FollowChatEvents
    ) => Effect.Effect<OpenChatEventFollow, ChatEventStoreError, Scope.Scope>
    readonly activeProjection: (
      input: ReadChatActiveProjection
    ) => Effect.Effect<ChatActiveProjection, ChatEventStoreError>
  }
>()("@arden-hq/server/persistence/events/ChatEventStore") {}
