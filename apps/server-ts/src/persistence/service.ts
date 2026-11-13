import { Context, Schema, type Effect } from "effect"
import type { SqlError } from "effect/unstable/sql"

export class StorageStartupError extends Schema.TaggedError<StorageStartupError>()(
  "StorageStartupError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const NEWER_DATA_OPERATION = "open_newer_data"

export const SCHEMA_CONVERT_FAILED_OPERATION = "convert_schema"

export class Persistence extends Context.Service<
  Persistence,
  {
    readonly recoverAfterRestart: Effect.Effect<void, StorageStartupError>
    readonly retentionTick: Effect.Effect<void, StorageStartupError>
    /** Fills the search index in the background after an upgrade or reset, a
     * chunk per write-queue item; returns when it is complete. */
    readonly fillSearchIndex: Effect.Effect<void>
    /** Fills the index, then applies each later message change to it within
     * seconds; never returns. The engine runs this in the background. */
    readonly keepSearchIndexCurrent: Effect.Effect<void>
    /** Runs `read` in one read transaction on a reader connection: every
     * statement on the reader sees the same commit, and none waits for the
     * writer. A statement on the writer inside it runs outside it. */
    readonly snapshot: <A, E>(read: Effect.Effect<A, E>) => Effect.Effect<A, E | SqlError.SqlError>
    /** Runs `read` in the write queue, after every queued write and its
     * after-commit work. Kept only as the chat-open fallback when a snapshot
     * keeps disagreeing with the in-memory projection (chat/events.ts). */
    readonly consistentRead: <A, E>(read: Effect.Effect<A, E>) => Effect.Effect<A, E>
    readonly drain: Effect.Effect<void>
  }
>()("@arden-hq/server/persistence/Persistence") {}
