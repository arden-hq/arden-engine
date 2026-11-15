import { Clock, Effect } from "effect"

import {
  parseIdempotencyRecord,
  transactionRecord,
  type Transaction
} from "../domain/transaction.js"
import {
  applyChangeSet,
  requestIdentity,
  type AppliedChangeSet,
  type MaterializationRow,
  type RequestIdentity,
  type ResourceSnapshot
} from "../domain/change-set.js"
import { encodeCommitRecord, encodeTreeRecord, parseCommitObject } from "../domain/codec.js"
import type { ChangeSet, Commit } from "../domain/model.js"
import {
  CorruptRepositoryError,
  IdempotencyConflictError,
  InvalidRevisionInputError,
  RevisionConflictError,
  type RevisionError,
  WorkingFileChangedError
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

export const commit = Effect.fn("RevisionRepository.commit")(function* (
  storage: RevisionStorageShape,
  head: Effect.Effect<string | null, RevisionError>,
  changeSet: ChangeSet,
  checkpoint?: (stage: string) => Effect.Effect<void, RevisionError>
): Effect.fn.Return<CommitResult, RevisionError> {
  const critical = Effect.gen(function* () {
    const prepared = yield* prepare(storage, head, changeSet)
    if (prepared.kind === "replayed") return prepared.result
    for (const row of prepared.applied.rows) yield* requireUnchangedOutside(storage, row)
    const written = yield* writeTransaction(storage, changeSet, prepared)
    yield* markPrepared(storage, written.transaction, prepared.oldHead, checkpoint)
    yield* installRows(storage, written.transaction)
    return yield* finish(storage, written, checkpoint)
  })
  return yield* storage.withLock(critical)
})

/**
 * Records a change to `resourceId` that is already in its working file: one update or archive,
 * with nothing installed.
 */
export const adoptWorkingChange = Effect.fn("RevisionRepository.adoptWorkingChange")(function* (
  storage: RevisionStorageShape,
  head: Effect.Effect<string | null, RevisionError>,
  changeSet: ChangeSet,
  resourceId: string,
  checkpoint?: (stage: string) => Effect.Effect<void, RevisionError>
): Effect.fn.Return<CommitResult, RevisionError> {
  const critical = Effect.gen(function* () {
    const prepared = yield* prepare(storage, head, changeSet)
    if (prepared.kind === "replayed") return prepared.result
    const [operation, ...rest] = changeSet.operations
    if (
      operation === undefined ||
      rest.length > 0 ||
      operation.resourceId !== resourceId ||
      (operation._tag !== "Update" && operation._tag !== "Archive")
    ) {
      return yield* new InvalidRevisionInputError({
        message: "working-tree adoption takes one update or archive of its own resource"
      })
    }
    const adoptedPath = prepared.before.get(resourceId)?.path
    for (const row of prepared.applied.rows) {
      if (adoptedPath === row.path) yield* requireAlreadyInWorkingTree(storage, row)
      else yield* requireUnchangedOutside(storage, row)
    }
    const written = yield* writeTransaction(storage, changeSet, prepared)
    yield* storage.writeMetadata(
      `transactions/${written.transaction.transactionId}/markers/ADOPTING`,
      new Uint8Array(),
      true
    )
    yield* markPrepared(storage, written.transaction, prepared.oldHead, checkpoint)
    return yield* finish(storage, written, checkpoint)
  })
  return yield* storage.withLock(critical)
})

type Prepared =
  | { readonly kind: "replayed"; readonly result: CommitResult }
  | {
      readonly kind: "prepared"
      readonly identity: RequestIdentity
      readonly oldHead: string | null
      readonly before: ResourceSnapshot
      readonly applied: AppliedChangeSet
    }

const prepare = Effect.fn("RevisionRepository.prepare")(function* (
  storage: RevisionStorageShape,
  head: Effect.Effect<string | null, RevisionError>,
  changeSet: ChangeSet
): Effect.fn.Return<Prepared, RevisionError> {
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
      kind: "replayed",
      result: {
        commit: yield* storage
          .readCommit(record.commitId)
          .pipe(Effect.flatMap((bytes) => parseCommitObject(record.commitId, bytes))),
        replayed: true
      }
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
  return { kind: "prepared", identity, oldHead, before, applied }
})

const requireUnchangedOutside = Effect.fn("RevisionRepository.requireUnchangedOutside")(function* (
  storage: RevisionStorageShape,
  row: MaterializationRow
) {
  const current = yield* workingHash(storage, row.path)
  if (current !== row.oldBlob && current !== row.newBlob)
    return yield* new WorkingFileChangedError({
      path: row.path,
      message: `${row.path} differs from its history: it was changed outside the repository`
    })
})

const requireAlreadyInWorkingTree = Effect.fn("RevisionRepository.requireAlreadyInWorkingTree")(
  function* (storage: RevisionStorageShape, row: MaterializationRow) {
    if ((yield* workingHash(storage, row.path)) !== row.newBlob)
      return yield* new RevisionConflictError({
        message: `working file changed after the scan: ${row.path}`
      })
  }
)

const writeTransaction = Effect.fn("RevisionRepository.writeTransaction")(function* (
  storage: RevisionStorageShape,
  changeSet: ChangeSet,
  prepared: Extract<Prepared, { readonly kind: "prepared" }>
): Effect.fn.Return<
  { readonly transaction: Transaction; readonly commitBytes: Uint8Array },
  RevisionError
> {
  const { applied, identity, oldHead } = prepared
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
  return { transaction, commitBytes }
})

const markPrepared = Effect.fn("RevisionRepository.markPrepared")(function* (
  storage: RevisionStorageShape,
  transaction: Transaction,
  oldHead: string | null,
  checkpoint: ((stage: string) => Effect.Effect<void, RevisionError>) | undefined
) {
  yield* writePreparedMarker(storage, yield* validateBeforePrepare(storage, transaction))
  if (checkpoint !== undefined) yield* checkpoint("after_prepared")
  yield* storage.readRef.pipe(
    Effect.flatMap((current) =>
      current === oldHead
        ? Effect.succeed(undefined)
        : new RevisionConflictError({ message: "current ref changed before materialization" })
    )
  )
})

const finish = Effect.fn("RevisionRepository.finish")(function* (
  storage: RevisionStorageShape,
  {
    transaction,
    commitBytes
  }: { readonly transaction: Transaction; readonly commitBytes: Uint8Array },
  checkpoint: ((stage: string) => Effect.Effect<void, RevisionError>) | undefined
): Effect.fn.Return<CommitResult, RevisionError> {
  const { transactionId, oldHead, newHead } = transaction
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
  yield* writeIdempotencyRecord(storage, transaction.keyHash, transaction.requestHash, newHead)
  yield* storage.writeMetadata(
    `transactions/${transactionId}/markers/COMMITTED`,
    new Uint8Array(),
    true
  )
  yield* storage.removeMetadataTree(`transactions/${transactionId}`)
  return { commit: yield* parseCommitObject(newHead, commitBytes), replayed: false }
})
