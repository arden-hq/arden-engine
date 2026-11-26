import { Clock, Effect, Result } from "effect"

import { isActive, type ResourceVersion } from "../domain/model.js"
import { WORKING_ENTRY_KIND } from "../storage/files.js"
import type { WorkingChange } from "./commit.js"
import type { RevisionStorageShape, StorageError } from "../storage/service-types.js"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

export const WORKING_FILE_CHANGE_KIND = {
  changed: "changed",
  missing: "missing",
  unreadable: "unreadable"
} as const

export type WorkingFileChange =
  | {
      readonly kind: typeof WORKING_FILE_CHANGE_KIND.changed
      readonly resource: ResourceVersion
      readonly content: Uint8Array
    }
  | { readonly kind: typeof WORKING_FILE_CHANGE_KIND.missing; readonly resource: ResourceVersion }
  | {
      readonly kind: typeof WORKING_FILE_CHANGE_KIND.unreadable
      readonly resource: ResourceVersion
      readonly reason: string
    }

export type AdoptableWorkingChange = Exclude<
  WorkingFileChange,
  { readonly kind: typeof WORKING_FILE_CHANGE_KIND.unreadable }
>

export const UNTRACKED_FILE_KIND = {
  listed: "listed",
  read: "read",
  unreadable: "unreadable"
} as const

export type UntrackedFile =
  | { readonly kind: typeof UNTRACKED_FILE_KIND.listed; readonly path: string }
  | {
      readonly kind: typeof UNTRACKED_FILE_KIND.read
      readonly path: string
      readonly content: Uint8Array
    }
  | {
      readonly kind: typeof UNTRACKED_FILE_KIND.unreadable
      readonly path: string
      readonly reason: string
    }

export const adoptedChange = (change: AdoptableWorkingChange): WorkingChange => ({
  resourceId: change.resource.resourceId,
  expectedVersion: change.resource.versionId,
  content: change.kind === WORKING_FILE_CHANGE_KIND.changed ? change.content : null
})

export interface WorkingTreeStatus {
  readonly revision: string | null
  readonly changes: ReadonlyArray<WorkingFileChange>
  readonly untracked: ReadonlyArray<UntrackedFile>
}

export interface WorkingTreeStatusOptions {
  readonly readUntracked?: (path: string) => boolean
}

interface MatchedStamp {
  readonly stamp: string
  readonly blobId: string
}

export interface WorkingScan {
  matched: ReadonlyMap<string, MatchedStamp>
  count: number
}

export const newWorkingScan = (): WorkingScan => ({ matched: new Map(), count: 0 })

const SETTLED_MS = 2_000
const FULL_SCAN_EVERY = 60

export const scanWorkingTree = Effect.fn("RevisionRepository.scanWorkingTree")(function* (
  storage: RevisionStorageShape,
  scan: WorkingScan,
  revision: string | null,
  resources: ReadonlyMap<string, ResourceVersion>,
  statusOptions: WorkingTreeStatusOptions
): Effect.fn.Return<WorkingTreeStatus, StorageError> {
  const active = [...resources.values()]
    .filter(isActive)
    .sort((left, right) => compareCodePoints(left.resourceId, right.resourceId))
  const changes: WorkingFileChange[] = []
  const startedAt = yield* Clock.currentTimeMillis
  const rehashAll = scan.count % FULL_SCAN_EVERY === 0
  scan.count += 1
  const listing = yield* storage.listWorkingFiles
  const stamps = new Map(
    listing.flatMap((entry) =>
      entry.kind === WORKING_ENTRY_KIND.file && entry.stamp !== undefined
        ? [[entry.path, entry.stamp] as const]
        : []
    )
  )
  const stillMatched = new Map<string, MatchedStamp>()
  for (const resource of active) {
    const stamp = stamps.get(resource.path)
    const known = scan.matched.get(resource.path)
    if (
      !rehashAll &&
      stamp !== undefined &&
      known?.stamp === stamp.id &&
      known.blobId === resource.blobId
    ) {
      stillMatched.set(resource.path, known)
      continue
    }
    const read = yield* Effect.result(storage.readWorking(resource.path, true, true))
    if (Result.isFailure(read)) {
      changes.push({
        kind: WORKING_FILE_CHANGE_KIND.unreadable,
        resource,
        reason: read.failure.message
      })
    } else if (read.success === null) {
      changes.push({ kind: WORKING_FILE_CHANGE_KIND.missing, resource })
    } else if (sha256Hex(read.success) !== resource.blobId) {
      changes.push({
        kind: WORKING_FILE_CHANGE_KIND.changed,
        resource,
        content: new Uint8Array(read.success)
      })
    } else if (stamp !== undefined && stamp.modifiedAt < startedAt - SETTLED_MS) {
      stillMatched.set(resource.path, { stamp: stamp.id, blobId: resource.blobId })
    }
  }
  scan.matched = stillMatched
  const tracked = new Set(active.map((resource) => resource.path))
  const untracked: UntrackedFile[] = []
  for (const entry of listing) {
    if (tracked.has(entry.path)) continue
    if (
      entry.kind === WORKING_ENTRY_KIND.unreadable ||
      statusOptions.readUntracked?.(entry.path) !== true
    ) {
      untracked.push(
        entry.kind === WORKING_ENTRY_KIND.file
          ? { kind: UNTRACKED_FILE_KIND.listed, path: entry.path }
          : entry
      )
      continue
    }
    const read = yield* Effect.result(storage.readWorking(entry.path, true, true))
    if (Result.isFailure(read))
      untracked.push({
        kind: UNTRACKED_FILE_KIND.unreadable,
        path: entry.path,
        reason: read.failure.message
      })
    else if (read.success !== null)
      untracked.push({
        kind: UNTRACKED_FILE_KIND.read,
        path: entry.path,
        content: new Uint8Array(read.success)
      })
  }
  return { revision, changes, untracked }
})
