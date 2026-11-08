import { Effect, Schema } from "effect"

import {
  ChangeSet,
  Operation as OperationSchema,
  ResourceChange,
  ResourceVersion,
  makeVersion,
  normalizeRelativePath
} from "./model.js"
import type { Operation } from "./model.js"
import {
  CorruptRepositoryError,
  InvalidRevisionInputError,
  NoChangesError,
  RevisionConflictError,
  UnsafePathError
} from "./errors.js"
import { canonicalJsonl, encodeUtf8 } from "./format.js"
import type { JsonRecord, JsonValue } from "./format.js"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

/** The immutable resource map consumed by the pure change-set algorithms. */
export type ResourceSnapshot = ReadonlyMap<string, ResourceVersion>

/** One active-file publication delta. */
export interface MaterializationRow {
  readonly path: string
  readonly oldBlob: string | null
  readonly newBlob: string | null
}

/** Pure result of applying one validated change set. */
export interface AppliedChangeSet {
  readonly resulting: ResourceSnapshot
  readonly changes: readonly ResourceChange[]
  readonly payloads: ReadonlyMap<string, Uint8Array>
  readonly rows: readonly MaterializationRow[]
}

/** Content-addressed request identities used by idempotent persistence. */
export interface RequestIdentity {
  readonly request: JsonRecord
  readonly requestHash: string
  readonly keyHash: string
}

type ChangeSetError =
  | CorruptRepositoryError
  | InvalidRevisionInputError
  | NoChangesError
  | RevisionConflictError
  | UnsafePathError

const failInput = (message: string): Effect.Effect<never, InvalidRevisionInputError> =>
  Effect.fail(new InvalidRevisionInputError({ message }))

const failConflict = (message: string): Effect.Effect<never, RevisionConflictError> =>
  Effect.fail(new RevisionConflictError({ message }))

const failCorrupt = (message: string): Effect.Effect<never, CorruptRepositoryError> =>
  Effect.fail(new CorruptRepositoryError({ message }))

const failNoChanges = (message: string): Effect.Effect<never, NoChangesError> =>
  Effect.fail(new NoChangesError({ message }))

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const rejectAncestorCollisions = (
  paths: Iterable<string>
): Effect.Effect<void, RevisionConflictError> => {
  const sorted = [...paths].sort(compareCodePoints)
  for (const [index, path] of sorted.entries()) {
    const candidate = sorted[index + 1]
    if (candidate?.startsWith(`${path}/`) === true) {
      return failConflict(`managed file paths overlap: ${path} and ${candidate}`)
    }
  }
  return Effect.succeed(undefined)
}

const validateActivePaths = Effect.fn("validateActivePaths")(function* (
  resources: ResourceSnapshot
): Effect.fn.Return<void, RevisionConflictError> {
  const paths = [...resources.values()]
    .filter((version) => version.state === "active")
    .map((version) => version.path)
  if (new Set(paths).size !== paths.length) {
    return yield* failConflict("two active resources cannot share one path")
  }
  yield* rejectAncestorCollisions(paths)
})

const activePathBlobs = Effect.fn("activePathBlobs")(function* (
  resources: ResourceSnapshot
): Effect.fn.Return<ReadonlyMap<string, string>, RevisionConflictError> {
  const paths = new Map<string, string>()
  for (const version of resources.values()) {
    if (version.state !== "active") continue
    if (paths.has(version.path))
      return yield* failConflict("two active resources cannot share one path")
    paths.set(version.path, version.blobId)
  }
  yield* rejectAncestorCollisions(paths.keys())
  return paths
})

/** Calculate file publication rows from two materialized resource snapshots. */
export const materializationRows = Effect.fn("materializationRows")(function* (
  before: ResourceSnapshot,
  after: ResourceSnapshot
): Effect.fn.Return<readonly MaterializationRow[], RevisionConflictError> {
  const oldPaths = yield* activePathBlobs(before)
  const newPaths = yield* activePathBlobs(after)
  const paths = [...new Set([...oldPaths.keys(), ...newPaths.keys()])].sort(compareCodePoints)
  return paths
    .filter((path) => oldPaths.get(path) !== newPaths.get(path))
    .map((path) => ({
      path,
      oldBlob: oldPaths.get(path) ?? null,
      newBlob: newPaths.get(path) ?? null
    }))
})

const validateOperationSchema = Effect.fn("validateOperationSchema")(function* (
  operation: unknown
): Effect.fn.Return<Operation, InvalidRevisionInputError> {
  return yield* Schema.decodeUnknownEffect(OperationSchema)(operation).pipe(
    Effect.mapError(
      () =>
        new InvalidRevisionInputError({
          message: "operations contain an invalid revision operation"
        })
    )
  )
})

const validateChangeSet = Effect.fn("validateChangeSet")(function* (
  value: unknown
): Effect.fn.Return<ChangeSet, InvalidRevisionInputError> {
  const changeSet = yield* Schema.decodeUnknownEffect(ChangeSet)(value).pipe(
    Effect.mapError(
      () => new InvalidRevisionInputError({ message: "change set has an invalid shape" })
    )
  )
  for (const operation of changeSet.operations) yield* validateOperationSchema(operation)
  if (
    changeSet.expectedHead !== null &&
    changeSet.expectedHead !== undefined &&
    changeSet.enforceExpectedHead === true
  ) {
    return yield* failInput("enforceExpectedHead is only valid when expectedHead is empty")
  }
  return changeSet
})

const requireActive = (
  version: ResourceVersion,
  operation: string
): Effect.Effect<void, RevisionConflictError> =>
  version.state === "active"
    ? Effect.succeed(undefined)
    : failConflict(`cannot ${operation} archived resource ${version.resourceId}`)

const recordPayload = (
  payloads: Map<string, Uint8Array>,
  content: Uint8Array
): Effect.Effect<string, CorruptRepositoryError> => {
  const copy = new Uint8Array(content)
  const blobId = sha256Hex(copy)
  const existing = payloads.get(blobId)
  if (existing !== undefined && !bytesEqual(existing, copy)) {
    return failCorrupt(`SHA-256 collision for blob ${blobId}`)
  }
  payloads.set(blobId, copy)
  return Effect.succeed(blobId)
}

/** Apply Create/Update/Move/Archive/Restore to an immutable snapshot. */
export const applyChangeSet = Effect.fn("applyChangeSet")(function* (
  value: ChangeSet,
  current: ResourceSnapshot
): Effect.fn.Return<AppliedChangeSet, ChangeSetError> {
  const changeSet = yield* validateChangeSet(value)
  yield* validateActivePaths(current)
  const ordered = [...changeSet.operations].sort((left, right) =>
    compareCodePoints(left.resourceId, right.resourceId)
  )
  const resourceIds = ordered.map((operation) => operation.resourceId)
  if (new Set(resourceIds).size !== resourceIds.length) {
    return yield* failInput("a change set may touch each resource only once")
  }

  const resulting = new Map(current)
  const changes: ResourceChange[] = []
  const payloads = new Map<string, Uint8Array>()

  for (const operation of ordered) {
    const before = current.get(operation.resourceId)
    let after: ResourceVersion
    let action: string

    if (operation._tag === "Create") {
      if (before !== undefined)
        return yield* failConflict(`resource already exists: ${operation.resourceId}`)
      const blobId = yield* recordPayload(payloads, operation.content)
      after = yield* makeVersion(operation.resourceId, operation.path, blobId, "active", null)
      action = "create"
    } else {
      if (before === undefined)
        return yield* failConflict(`resource does not exist: ${operation.resourceId}`)
      if (before.versionId !== operation.expectedVersion) {
        return yield* failConflict(
          `resource ${operation.resourceId} changed: expected ${operation.expectedVersion}, found ${before.versionId}`
        )
      }

      if (operation._tag === "Update") {
        yield* requireActive(before, "update")
        const blobId = yield* recordPayload(payloads, operation.content)
        after = yield* makeVersion(
          operation.resourceId,
          before.path,
          blobId,
          "active",
          before.versionId
        )
        action = "update"
      } else if (operation._tag === "Move") {
        yield* requireActive(before, "move")
        const blobId =
          operation.content === undefined
            ? before.blobId
            : yield* recordPayload(payloads, operation.content)
        after = yield* makeVersion(
          operation.resourceId,
          operation.path,
          blobId,
          "active",
          before.versionId
        )
        action = "move"
      } else if (operation._tag === "Archive") {
        yield* requireActive(before, "archive")
        after = yield* makeVersion(
          operation.resourceId,
          before.path,
          before.blobId,
          "archived",
          before.versionId
        )
        action = "archive"
      } else {
        const blobId =
          operation.content === undefined
            ? before.blobId
            : yield* recordPayload(payloads, operation.content)
        const path = operation.path === undefined ? before.path : operation.path
        after = yield* makeVersion(operation.resourceId, path, blobId, "active", before.versionId)
        action = "restore"
      }
    }

    if (before !== undefined && isSameSubstance(before, after)) {
      return yield* failNoChanges(`${action} produces no change for ${operation.resourceId}`)
    }
    resulting.set(operation.resourceId, after)
    changes.push(
      new ResourceChange({
        action,
        before: before ?? null,
        after
      })
    )
  }

  yield* validateActivePaths(resulting)
  const rows = yield* materializationRows(current, resulting)
  return { resulting, changes, payloads, rows }
})

const isSameSubstance = (before: ResourceVersion, after: ResourceVersion): boolean =>
  before.path === after.path && before.blobId === after.blobId && before.state === after.state

const operationRequestRecord = Effect.fn("operationRequestRecord")(function* (
  operation: Operation
): Effect.fn.Return<JsonRecord, UnsafePathError> {
  const base: Record<string, JsonValue> = {
    resource_id: operation.resourceId,
    operation: operation._tag.toLowerCase()
  }
  if (operation._tag === "Create") {
    base.path = yield* normalizeRelativePath(operation.path)
    base.content_hash = sha256Hex(operation.content)
  } else {
    base.expected_version = operation.expectedVersion
    if (operation._tag === "Update") {
      base.content_hash = sha256Hex(operation.content)
    } else if (operation._tag === "Move") {
      base.path = yield* normalizeRelativePath(operation.path)
      base.content_hash = operation.content === undefined ? null : sha256Hex(operation.content)
    } else if (operation._tag === "Restore") {
      base.path = operation.path === undefined ? null : yield* normalizeRelativePath(operation.path)
      base.content_hash = operation.content === undefined ? null : sha256Hex(operation.content)
    }
  }
  return base
})

/** Build the deterministic request and idempotency hashes used by persistence. */
export const requestIdentity = Effect.fn("requestIdentity")(function* (
  value: ChangeSet
): Effect.fn.Return<RequestIdentity, InvalidRevisionInputError | UnsafePathError> {
  const changeSet = yield* validateChangeSet(value)
  const operations: JsonRecord[] = []
  const ordered = [...changeSet.operations].sort((left, right) =>
    compareCodePoints(left.resourceId, right.resourceId)
  )
  for (const operation of ordered) operations.push(yield* operationRequestRecord(operation))
  const request: Record<string, JsonValue> = {
    version: 1,
    actor: changeSet.actor,
    origin: changeSet.origin,
    reason: changeSet.reason,
    expected_head: changeSet.expectedHead ?? null,
    operations
  }
  if (changeSet.enforceExpectedHead === true) request.enforce_expected_head = true
  const encoded = canonicalJsonl(request)
  return {
    request,
    requestHash: sha256Hex(encoded),
    keyHash: sha256Hex(encodeUtf8(changeSet.idempotencyKey))
  }
})
