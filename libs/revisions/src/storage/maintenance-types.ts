import { Effect } from "effect"

import {
  CorruptRepositoryError,
  InvalidRevisionInputError,
  RevisionStorageError,
  UnsafePathError
} from "../domain/errors.js"
import { type ObjectKind } from "../domain/format.js"

export interface MaintenanceObjectEntry {
  readonly name: string
  readonly byteSize: number
  readonly modifiedAtMillis: number
}

interface MaintenancePublishedEntry {
  readonly commitId: string
}

export interface MaintenanceIdempotencyRecord {
  readonly keyHash: string
  readonly requestHash: string
  readonly commitId: string
}

interface MaintenanceTransactionRow {
  readonly path: string
  readonly oldBlob: string | null
  readonly newBlob: string | null
}

export interface MaintenanceProtectedTransaction {
  readonly transactionId: string
  readonly oldHead: string | null
  readonly newHead: string
  readonly treeId: string
  readonly rows: ReadonlyArray<MaintenanceTransactionRow>
  readonly conflicted?: boolean
}

export interface MaintenanceMetadataStats {
  readonly transactionBytes: number
  readonly conflictBytes: number
  readonly idempotencyBytes: number
  readonly publicationBytes: number
  readonly refBytes: number
  readonly lockBytes: number | null
}

export type MaintenanceStorageError =
  | CorruptRepositoryError
  | RevisionStorageError
  | UnsafePathError

export interface MaintenanceStorage {
  readonly readRef: Effect.Effect<string | null, MaintenanceStorageError>
  readonly listObjects: (
    kind: ObjectKind
  ) => Effect.Effect<ReadonlyArray<MaintenanceObjectEntry>, MaintenanceStorageError>
  readonly readObject: (
    kind: ObjectKind,
    id: string
  ) => Effect.Effect<Uint8Array, MaintenanceStorageError>
  readonly readWorking: (path: string) => Effect.Effect<Uint8Array | null, MaintenanceStorageError>
  readonly listPublished: Effect.Effect<
    ReadonlyArray<MaintenancePublishedEntry>,
    MaintenanceStorageError
  >
  readonly listIdempotency: Effect.Effect<
    ReadonlyArray<MaintenanceIdempotencyRecord>,
    MaintenanceStorageError
  >
  readonly listProtectedTransactions: Effect.Effect<
    ReadonlyArray<MaintenanceProtectedTransaction>,
    MaintenanceStorageError
  >
  readonly metadataStats: Effect.Effect<MaintenanceMetadataStats, MaintenanceStorageError>
  readonly removeObject: (
    kind: ObjectKind,
    id: string
  ) => Effect.Effect<void, MaintenanceStorageError>
}

export interface IntegrityIssue {
  readonly code: string
  readonly target: string
  readonly detail: string
}

export interface IntegrityReport {
  readonly ok: boolean
  readonly headCommit: string | null
  readonly resources: number
  readonly objects: number
  readonly issues: ReadonlyArray<IntegrityIssue>
}

export interface StorageReport {
  readonly totalBytes: number
  readonly blobBytes: number
  readonly treeBytes: number
  readonly commitBytes: number
  readonly recoveryBytes: number
  readonly metadataBytes: number
  readonly resourceCount: number
  readonly commitCount: number
  readonly objectCount: number
}

export interface CollectionReport {
  readonly scanned: number
  readonly removed: number
  readonly retained: number
  readonly bytesRemoved: number
}

export interface CollectionRoots {
  readonly commits: ReadonlySet<string>
  readonly trees: ReadonlySet<string>
  readonly blobs: ReadonlySet<string>
}

export interface CollectionOptions {
  readonly roots?: CollectionRoots
  readonly nowMillis?: number
  readonly gracePeriodMs?: number
  readonly cutoffMillis?: number
}

export type MaintenanceError = MaintenanceStorageError | InvalidRevisionInputError
