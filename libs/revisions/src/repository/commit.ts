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

/**
 * One commit under the repository lock: prepare, materialize, publish. With `adopting`, the
 * commit records an outside change to that one resource that is already in the working tree.
 */
export const commit = Effect.fn("RevisionRepository.commit")(function* (
  storage: RevisionStorageShape,
  head: Effect.Effect<string | null, RevisionError>,
  changeSet: ChangeSet,
  checkpoint?: (stage: string) => Effect.Effect<void, RevisionError>,
  adopting?: string
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
    if (adopting !== undefined) {
      const [operation, ...rest] = changeSet.operations
      if (
        operation === undefined ||
        rest.length > 0 ||
        operation.resourceId !== adopting ||
        (operation._tag !== "Update" && operation._tag !== "Archive")
      ) {
        return yield* new InvalidRevisionInputError({
          message: "working-tree adoption takes one update or archive of its own resource"
        })
      }
    }
    const adoptedPath = adopting === undefined ? undefined : before.get(adopting)?.path
    for (const row of applied.rows) {
      const outside = adoptedPath === row.path
      const expected = outside ? row.newBlob : row.oldBlob
      if ((yield* workingHash(storage, row.path)) !== expected) {
        return yield* new RevisionConflictError({
          message: outside
            ? `working file changed after the scan: ${row.path}`
            : `working file changed: ${row.path}`
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
    if (adopting !== undefined) {
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
    yield* installRows(storage, transaction, adopting !== undefined)
    yield* validateWorkingTree(storage, transaction)
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
