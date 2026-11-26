import { Effect } from "effect"

import { Commit, ResourceVersion } from "../domain/model.js"
import type { RevisionError } from "../domain/errors.js"
import { type AdoptWorkingChangeOptions, type CommitInput, type CommitResult } from "./commit.js"
import type { ResourceDiff, ResourceDiffPage } from "../domain/query.js"
import {
  type CollectionReport,
  type IntegrityReport,
  type StorageReport
} from "../storage/maintenance-types.js"
import { type RevisionStorageOptions } from "../storage/service-types.js"
import {
  type AdoptableWorkingChange,
  type WorkingTreeStatus,
  type WorkingTreeStatusOptions
} from "./working.js"

export type RepositoryError = RevisionError

export type RepositoryOpenPhase =
  | "revision_storage_ready"
  | "revision_lock_acquired"
  | "revision_initialized"
  | "revision_recovered"
  | "revision_ref_checked"

export interface ManagedFileRepositoryOptions extends RevisionStorageOptions {
  readonly gcGracePeriodMs?: number
  readonly checkpoint?: (stage: string) => Effect.Effect<void, RepositoryError>
  readonly onOpenPhase?: (phase: RepositoryOpenPhase) => void
}

export interface ManagedFileRepositoryShape {
  readonly head: Effect.Effect<string | null, RepositoryError>
  readonly currentRevision: Effect.Effect<string | null, RepositoryError>
  readonly isReachable: (commitId: string) => Effect.Effect<boolean, RepositoryError>
  readonly get: (
    resourceId: string,
    options?: { readonly at?: string | null }
  ) => Effect.Effect<ResourceVersion | null, RepositoryError>
  readonly findByPath: (
    path: string,
    options?: { readonly at?: string | null; readonly includeArchived?: boolean }
  ) => Effect.Effect<ResourceVersion | null, RepositoryError>
  readonly listResources: (options?: {
    readonly at?: string | null
    readonly includeArchived?: boolean
  }) => Effect.Effect<readonly ResourceVersion[], RepositoryError>
  readonly read: (
    resourceId: string,
    options?: { readonly at?: string | null }
  ) => Effect.Effect<Uint8Array, RepositoryError>
  readonly readVersion: (version: ResourceVersion) => Effect.Effect<Uint8Array, RepositoryError>
  readonly contentSize: (
    resource: ResourceVersion | string,
    options?: { readonly at?: string | null }
  ) => Effect.Effect<number, RepositoryError>
  readonly inspectCommit: (commitId: string) => Effect.Effect<Commit, RepositoryError>
  readonly commit: (request: CommitInput) => Effect.Effect<CommitResult, RepositoryError>
  readonly idempotencyReceipt: (
    idempotencyKey: string
  ) => Effect.Effect<
    { readonly requestHash: string; readonly commitId: string } | null,
    RepositoryError
  >
  readonly finalizeIdempotencyReceipt: (
    idempotencyKey: string,
    requestIdentity: string
  ) => Effect.Effect<{ readonly requestHash: string; readonly commitId: string }, RepositoryError>
  readonly workingTreeStatus: (
    options?: WorkingTreeStatusOptions
  ) => Effect.Effect<WorkingTreeStatus, RepositoryError>
  readonly adoptWorkingChange: (
    change: AdoptableWorkingChange,
    options: AdoptWorkingChangeOptions
  ) => Effect.Effect<CommitResult, RepositoryError>
  readonly history: (options?: {
    readonly resourceId?: string | null
    readonly start?: string | null
    readonly stopBefore?: string | null
    readonly limit?: number | null
  }) => Effect.Effect<readonly Commit[], RepositoryError>
  readonly prepareHistory: () => Effect.Effect<void, RepositoryError>
  readonly diff: (
    base: string | null,
    target: string | null,
    options?: { readonly resourceIds?: Iterable<string> | null }
  ) => Effect.Effect<readonly ResourceDiff[], RepositoryError>
  readonly diffPage: (
    base: string | null,
    target: string | null,
    resourceId: string,
    options?: { readonly offset?: number; readonly limit?: number; readonly tail?: boolean }
  ) => Effect.Effect<ResourceDiffPage, RepositoryError>
  readonly diffVersionsPage: (
    before: ResourceVersion | null,
    after: ResourceVersion | null,
    options?: {
      readonly offset?: number
      readonly limit?: number
      readonly tail?: boolean
      readonly sourceByteLimit?: number | null
    }
  ) => Effect.Effect<ResourceDiffPage, RepositoryError>
  readonly restoreFromCommit: (
    resourceId: string,
    sourceCommit: string,
    options: {
      readonly expectedVersion: string
      readonly expectedHead?: string | null
      readonly enforceExpectedHead?: boolean
      readonly actor: string
      readonly origin: string
      readonly reason: string
      readonly idempotencyKey?: string
      readonly path?: string
    }
  ) => Effect.Effect<CommitResult, RepositoryError>
  readonly integrityReport: Effect.Effect<IntegrityReport, RepositoryError>
  readonly storageReport: Effect.Effect<StorageReport, RepositoryError>
  readonly collect: (options?: {
    readonly nowMillis?: number
    readonly gracePeriodMs?: number
  }) => Effect.Effect<CollectionReport, RepositoryError>
}
