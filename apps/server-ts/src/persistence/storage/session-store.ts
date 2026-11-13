import { storeErrorFields } from "../errors.js"
import { Context, Effect, Schema } from "effect"

export type StorageSessionProtection =
  | "active_work"
  | "automation_or_task"
  | "space_owned"
  | "linked_session"
  | "unfinished_todo"

export interface StorageSessionCandidate {
  readonly sessionId: string
  readonly name: string
  readonly archived: boolean
  readonly lastActivity: string
  readonly sizeBytes: number
  readonly deletesWith: {
    readonly agents: number
    readonly sideChats: number
    readonly sessionIds: ReadonlyArray<string>
  }
  readonly protections: ReadonlyArray<StorageSessionProtection>
}

export interface StorageSessionSnapshot {
  readonly candidates: ReadonlyArray<StorageSessionCandidate>
  readonly totalLogicalBytes: number
}

export interface StorageDatabaseBreakdown {
  readonly fileBytes: number
  readonly chatsBytes: number
  readonly channelsBytes: number
  readonly agentsBytes: number
  readonly knowledgeBytes: number
  readonly housekeepingBytes: number
  readonly currentChats: number
  readonly archivedChats: number
  readonly channels: number
  readonly agentRuns: number
}

/** Pages SQLite keeps for reuse; `incremental_vacuum` returns them to the
 * file system. */
export interface FreePages {
  readonly free: number
  readonly pageSize: number
}

export interface ReleasedPages {
  readonly released: number
  /** Free pages left after the batch. */
  readonly free: number
}

/** "passive" copies what it can without waiting; "truncate" waits for readers
 * and empties the WAL file. */
export type CheckpointMode = "passive" | "truncate"

export class StorageSessionStoreError extends Schema.TaggedError<StorageSessionStoreError>()(
  "StorageSessionStoreError",
  {
    ...storeErrorFields({
      operations: ["candidates", "breakdown", "compact", "delete"],
      reasons: ["conflict", "storage"]
    }),
    sessionId: Schema.optionalKey(Schema.NonEmptyString)
  }
) {}

export class StorageSessionStore extends Context.Service<
  StorageSessionStore,
  {
    readonly candidates: () => Effect.Effect<StorageSessionSnapshot, StorageSessionStoreError>
    readonly deleteCandidate: (
      candidate: StorageSessionCandidate
    ) => Effect.Effect<void, StorageSessionStoreError>
    readonly freePages: () => Effect.Effect<FreePages, StorageSessionStoreError>
    /** One write: releases at most `pages`, never below `reservePages`. */
    readonly releaseFreePages: (options: {
      readonly pages: number
      readonly reservePages: number
    }) => Effect.Effect<ReleasedPages, StorageSessionStoreError>
    readonly checkpoint: (mode: CheckpointMode) => Effect.Effect<void, StorageSessionStoreError>
    /** Whether writes are queued or a chat run is active: background work gives way. */
    readonly foregroundWork: () => Effect.Effect<boolean, StorageSessionStoreError>
    readonly breakdown: () => Effect.Effect<StorageDatabaseBreakdown, StorageSessionStoreError>
  }
>()("@arden-hq/server/persistence/storage/StorageSessionStore") {}
