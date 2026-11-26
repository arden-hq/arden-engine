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
    readonly fillSearchIndex: Effect.Effect<void>
    readonly keepSearchIndexCurrent: Effect.Effect<void>
    readonly snapshot: <A, E>(read: Effect.Effect<A, E>) => Effect.Effect<A, E | SqlError.SqlError>
    readonly consistentRead: <A, E>(read: Effect.Effect<A, E>) => Effect.Effect<A, E>
    readonly drain: Effect.Effect<void>
  }
>()("@arden-hq/server/persistence/Persistence") {}
