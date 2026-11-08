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
    readonly compact: () => Effect.Effect<void, StorageSessionStoreError>
    readonly breakdown: () => Effect.Effect<StorageDatabaseBreakdown, StorageSessionStoreError>
  }
>()("@arden-hq/server/persistence/storage/StorageSessionStore") {}
