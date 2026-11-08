import { Clock, Effect } from "effect"

import {
  parseIdempotencyRecord,
  transactionRecord,
  type Transaction
} from "../domain/transaction.js"
import { applyChangeSet, requestIdentity } from "../domain/change-set.js"
import { encodeCommitRecord, encodeTreeRecord, parseCommitObject } from "../domain/codec.js"
import type { ChangeSet, Commit } from "../domain/model.js"
import {
  CorruptRepositoryError,
  IdempotencyConflictError,
  InvalidRevisionInputError,
  RevisionConflictError,
  type RevisionError
} from "../domain/errors.js"
import {
  buildTreeObjects,
  canonicalJsonl,
  commitRecord,
  type JsonRecord
} from "../domain/format.js"
import type { RevisionStorageShape } from "../storage/service.js"
import { currentMap, timestamp } from "./state.js"
import {
  artifact,
  assertWorking,
  installRows,
  recoverTransactions,
  validateBeforePrepare,
  validateWorkingTree,
  workingHash,
  writeIdempotencyRecord,
  writePreparedMarker
} from "./transaction.js"
import { sha256Hex } from "@arden-hq/std/hash"

export interface CommitResult {
  readonly commit: Commit
  /** True when the idempotency key already named this exact request and its first commit was returned. */
  readonly replayed: boolean
}

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

/** One commit under the repository lock: prepare, materialize, publish. */
export const commit = Effect.fn("RevisionRepository.commit")(function* (
  storage: RevisionStorageShape,
  head: Effect.Effect<string | null, RevisionError>,
  changeSet: ChangeSet,
  checkpoint?: (stage: string) => Effect.Effect<void, RevisionError>,
  adoptedPaths?: ReadonlyMap<string, string>
): Effect.fn.Return<CommitResult, RevisionError> {
  const critical = Effect.gen(function* () {
    yield* recoverTransactions(storage)
    const identity = yield* requestIdentity(changeSet)
    const existing = yield* storage.readIdempotency(identity.keyHash)
    if (existing !== null) {
      const record = yield* parseIdempotencyRecord(existing, identity.keyHash)
      if (record.requestHash !== identity.requestHash)
        return yield* new IdempotencyConflictError({
          message: `idempotency key was reused for a different request: ${changeSet.idempotencyKey}`
        })
      return {
        commit: yield* storage
          .readCommit(record.commitId)
          .pipe(Effect.flatMap((bytes) => parseCommitObject(record.commitId, bytes))),
        replayed: true
      }
    }
    const oldHead = yield* head
    if (
      (changeSet.expectedHead !== null &&
        changeSet.expectedHead !== undefined &&
        changeSet.expectedHead !== oldHead) ||
      (changeSet.enforceExpectedHead === true && (changeSet.expectedHead ?? null) !== oldHead)
    ) {
      return yield* new RevisionConflictError({
        message: `expected head changed: expected ${changeSet.expectedHead ?? "null"}, found ${oldHead ?? "null"}`
      })
    }
    const before = yield* currentMap(storage, oldHead)
    const applied = yield* applyChangeSet(changeSet, before)
    const adopted =
      adoptedPaths === undefined
        ? null
        : new Map<string, { readonly path: string; readonly content: Uint8Array }>()
    if (adoptedPaths !== undefined && adopted !== null) {
      for (const operation of changeSet.operations) {
        if (operation._tag !== "Update") {
          return yield* new InvalidRevisionInputError({
            message: "working-tree adoption only supports active resource updates"
          })
        }
        const path = adoptedPaths.get(operation.resourceId)
        if (path === undefined) {
          return yield* new InvalidRevisionInputError({
            message: `working-tree adoption is missing resource: ${operation.resourceId}`
          })
        }
        adopted.set(operation.resourceId, { path, content: new Uint8Array(operation.content) })
      }
      if (adopted.size !== adoptedPaths.size) {
        return yield* new InvalidRevisionInputError({
          message: "working-tree adoption contains an unknown resource"
        })
      }
    }
    for (const resource of before.values()) {
      if (resource.state !== "active") continue
      const change = adopted?.get(resource.resourceId)
      if (change === undefined) {
        yield* assertWorking(storage, resource.path, resource.blobId)
        continue
      }
      if (change.path !== resource.path) {
        return yield* new RevisionConflictError({
          message: `managed resource path changed: ${resource.resourceId}`
        })
      }
      const content = yield* storage.readWorking(resource.path, true, true)
      if (content === null || !bytesEqual(content, change.content)) {
        return yield* new RevisionConflictError({
          message: `working file changed after preview: ${resource.path}`
        })
      }
    }
    for (const [blobId, content] of applied.payloads)
      if (sha256Hex(content) !== blobId)
        return yield* new CorruptRepositoryError({ message: `payload hash mismatch: ${blobId}` })
    for (const content of applied.payloads.values()) yield* storage.writeBlob(content)
    const trees = buildTreeObjects([...applied.resulting.values()])
    for (const [treeId, tree] of trees.objects) {
      if (sha256Hex(canonicalJsonl(tree as unknown as JsonRecord)) !== treeId)
        return yield* new CorruptRepositoryError({ message: `tree hash mismatch: ${treeId}` })
      yield* storage.writeTree(encodeTreeRecord(tree))
    }
    const now = yield* Clock.currentTimeMillis
    const record = {
      parentId: oldHead,
      treeId: trees.rootId,
      actor: changeSet.actor,
      origin: changeSet.origin,
      reason: changeSet.reason,
      timestamp: timestamp(now),
      changes: applied.changes
    }
    const commitBytes = encodeCommitRecord(commitRecord(record))
    const newHead = yield* storage.writeCommit(commitBytes)
    const rows = applied.rows
    const transactionWithoutId = {
      oldHead,
      newHead,
      treeId: trees.rootId,
      keyHash: identity.keyHash,
      requestHash: identity.requestHash,
      rows
    }
    const transactionId = sha256Hex(canonicalJsonl(transactionRecord(transactionWithoutId)))
    const transaction: Transaction = { transactionId, ...transactionWithoutId }
    yield* storage.ensureMetadataDirectory(`transactions/${transactionId}`)
    yield* storage.ensureMetadataDirectory(`transactions/${transactionId}/publish`)
    yield* storage.ensureMetadataDirectory(`transactions/${transactionId}/backups`)
    yield* storage.ensureMetadataDirectory(`transactions/${transactionId}/displaced`)
    yield* storage.ensureMetadataDirectory(`transactions/${transactionId}/rejected`)
    yield* storage.ensureMetadataDirectory(`transactions/${transactionId}/markers`)
    for (const [index, row] of rows.entries()) {
      if (row.newBlob !== null)
        yield* storage.writeMetadata(
          artifact(transactionId, "publish", index),
          yield* storage.readBlob(row.newBlob),
          true
        )
      if (row.oldBlob !== null)
        yield* storage.writeMetadata(
          artifact(transactionId, "backups", index),
          yield* storage.readBlob(row.oldBlob),
          true
        )
    }
    yield* storage.writeMetadata(
      `transactions/${transactionId}/manifest.jsonl`,
      canonicalJsonl(transactionRecord(transactionWithoutId)),
      true
    )
    if (adopted !== null) {
      yield* storage.writeMetadata(
        `transactions/${transactionId}/markers/ADOPTING`,
        new Uint8Array(),
        true
      )
    }
    yield* writePreparedMarker(storage, yield* validateBeforePrepare(storage, transaction))
    if (checkpoint !== undefined) yield* checkpoint("after_prepared")
    yield* storage.readRef.pipe(
      Effect.flatMap((current) =>
        current === oldHead
          ? Effect.succeed(undefined)
          : new RevisionConflictError({ message: "current ref changed before materialization" })
      )
    )
    yield* installRows(storage, transaction, adopted !== null)
    for (const row of rows) {
      const actual = yield* workingHash(storage, row.path)
      if (actual !== row.newBlob)
        return yield* new RevisionConflictError({
          message: `materialized path does not match new tree: ${row.path}`
        })
    }
    yield* validateWorkingTree(storage, newHead)
    if (checkpoint !== undefined) yield* checkpoint("before_ref")
    yield* storage.compareAndSwapRef(oldHead, newHead)
    if (checkpoint !== undefined) yield* checkpoint("after_ref")
    yield* storage.writeMetadata(
      `transactions/${transactionId}/markers/DECIDED`,
      new Uint8Array(),
      true
    )
    yield* storage.publish(newHead)
    yield* writeIdempotencyRecord(storage, identity.keyHash, identity.requestHash, newHead)
    yield* storage.writeMetadata(
      `transactions/${transactionId}/markers/COMMITTED`,
      new Uint8Array(),
      true
    )
    yield* storage.removeMetadataTree(`transactions/${transactionId}`)
    return { commit: yield* parseCommitObject(newHead, commitBytes), replayed: false }
  })
  return yield* storage.withLock(critical)
})
