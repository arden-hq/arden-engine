import { Context, Effect } from "effect"

import { RevisionConflictError, RevisionStorageError, UnsafePathError } from "../domain/errors.js"
import { type ObjectKind } from "../domain/format.js"
import { type WorkingEntry } from "./files.js"

export interface RevisionLockFactoryShape {
  readonly acquire: (
    lockPath: string,
    staleAfterMs: number
  ) => Effect.Effect<RevisionLock, RevisionStorageError | RevisionConflictError>
}

export interface RevisionStorageOptions {
  readonly workingRoot: string
  readonly historyRoot?: string
  readonly lockStaleAfterMs?: number
}

interface RevisionLock {
  readonly release: Effect.Effect<void, RevisionStorageError>
  readonly lost: Effect.Effect<never, RevisionStorageError>
}

export class RevisionLockFactory extends Context.Service<
  RevisionLockFactory,
  RevisionLockFactoryShape
>()("@arden-hq/revisions/RevisionLockFactory") {}

export type StorageError = RevisionStorageError | RevisionConflictError | UnsafePathError

export const jsonlStem = (name: string): string | null =>
  name.endsWith(".jsonl") ? name.slice(0, -6) : null

interface RevisionMetadataStat {
  readonly size: number
  readonly mtimeMillis: number | null
}

export interface RevisionStorageShape {
  readonly workingRoot: string
  readonly historyRoot: string
  readonly initialize: Effect.Effect<void, StorageError>
  readonly withLock: <A, E>(operation: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageError>
  readonly readBlob: (blobId: string) => Effect.Effect<Uint8Array, StorageError>
  readonly writeBlob: (content: Uint8Array) => Effect.Effect<string, StorageError>
  readonly readTree: (treeId: string) => Effect.Effect<Uint8Array, StorageError>
  readonly writeTree: (content: Uint8Array) => Effect.Effect<string, StorageError>
  readonly readCommit: (commitId: string) => Effect.Effect<Uint8Array, StorageError>
  readonly writeCommit: (content: Uint8Array) => Effect.Effect<string, StorageError>
  readonly blobSize: (blobId: string) => Effect.Effect<number, StorageError>
  readonly commitSize: (commitId: string) => Effect.Effect<number, StorageError>
  readonly listObjectIds: (kind: ObjectKind) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly removeObject: (
    kind: ObjectKind,
    id: string,
    missingOk?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly listPublished: Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly removePublished: (
    commitId: string,
    missingOk?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly metadataStat: (
    relativePath: string
  ) => Effect.Effect<RevisionMetadataStat | null, StorageError>
  readonly removeMetadataFile: (
    relativePath: string,
    missingOk?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly cleanupMetadataTemps: (relativeDirectory: string) => Effect.Effect<void, StorageError>
  readonly readRef: Effect.Effect<string | null, StorageError>
  readonly compareAndSwapRef: (
    expected: string | null,
    replacement: string | null
  ) => Effect.Effect<void, StorageError>
  readonly compensateRef: (
    expected: string,
    replacement: string | null
  ) => Effect.Effect<void, StorageError>
  readonly readIdempotency: (keyHash: string) => Effect.Effect<Uint8Array | null, StorageError>
  readonly writeIdempotency: (
    keyHash: string,
    content: Uint8Array
  ) => Effect.Effect<void, StorageError>
  readonly isPublished: (commitId: string) => Effect.Effect<boolean, StorageError>
  readonly publish: (commitId: string) => Effect.Effect<void, StorageError>
  readonly listMetadata: (
    relativePath: string
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly metadataExists: (relativePath: string) => Effect.Effect<boolean, StorageError>
  readonly readMetadata: (
    relativePath: string,
    allowMissing?: boolean
  ) => Effect.Effect<Uint8Array | null, StorageError>
  readonly writeMetadata: (
    relativePath: string,
    content: Uint8Array,
    noReplace?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly ensureMetadataDirectory: (relativePath: string) => Effect.Effect<void, StorageError>
  readonly removeMetadataTree: (relativePath: string) => Effect.Effect<void, StorageError>
  readonly renameMetadataDirectory: (
    source: string,
    target: string
  ) => Effect.Effect<void, StorageError>
  readonly readWorking: (
    relativePath: string,
    allowMissing?: boolean,
    requireStandalone?: boolean
  ) => Effect.Effect<Uint8Array | null, StorageError>
  readonly listWorkingFiles: Effect.Effect<ReadonlyArray<WorkingEntry>, StorageError>
  readonly writeWorking: (
    relativePath: string,
    content: Uint8Array,
    noReplace?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly removeWorking: (
    relativePath: string,
    missingOk?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly moveWorkingToMetadata: (
    workingPath: string,
    metadataPath: string
  ) => Effect.Effect<void, StorageError>
  readonly syncMetadataDirectory: (relativePath: string) => Effect.Effect<void, StorageError>
}

export class RevisionStorage extends Context.Service<RevisionStorage, RevisionStorageShape>()(
  "@arden-hq/revisions/RevisionStorage"
) {}
