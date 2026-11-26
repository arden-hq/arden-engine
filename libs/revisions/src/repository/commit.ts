import { randomUUID } from "node:crypto"

import { Clock, Effect, Schema } from "effect"

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
import { ChangeSet, type Commit } from "../domain/model.js"
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
import type { RevisionStorageShape } from "../storage/service-types.js"
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

export type CommitInput = Omit<typeof ChangeSet.Encoded, "idempotencyKey"> & {
  readonly idempotencyKey?: string
}

export const decodeChangeSet = Effect.fn("decodeChangeSet")(function* (
  request: CommitInput
): Effect.fn.Return<ChangeSet, InvalidRevisionInputError> {
  return yield* Schema.decodeUnknownEffect(ChangeSet)({
    ...request,
    idempotencyKey: request.idempotencyKey ?? randomUUID()
  }).pipe(Effect.mapError((cause) => new InvalidRevisionInputError({ message: cause.message })))
})

export interface CommitResult {
  readonly commit: Commit
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
    if (prepared.kind === PREPARED_KIND.replayed) return prepared.result
    for (const row of prepared.applied.rows) yield* requireUnchangedOutside(storage, row)
    const written = yield* writeTransaction(storage, changeSet, prepared)
    yield* markPrepared(storage, written.transaction, prepared.oldHead, checkpoint)
    yield* installRows(storage, written.transaction)
    return yield* finish(storage, written, checkpoint)
  })
  return yield* storage.withLock(critical)
})

export interface AdoptWorkingChangeOptions {
  readonly actor: string
  readonly origin: string
  readonly reason: string
  readonly expectedHead: string | null
}

export interface WorkingChange {
  readonly resourceId: string
  readonly expectedVersion: string
  readonly content: Uint8Array | null
}

export const adoptWorkingChange = Effect.fn("RevisionRepository.adoptWorkingChange")(function* (
  storage: RevisionStorageShape,
  head: Effect.Effect<string | null, RevisionError>,
  change: WorkingChange,
  options: AdoptWorkingChangeOptions,
  checkpoint?: (stage: string) => Effect.Effect<void, RevisionError>
): Effect.fn.Return<CommitResult, RevisionError> {
  const { resourceId, expectedVersion, content } = change
  const changeSet = yield* decodeChangeSet({
    operations: [
      content === null
        ? { _tag: "Archive", resourceId, expectedVersion }
        : { _tag: "Update", resourceId, expectedVersion, content }
    ],
    actor: options.actor,
    origin: options.origin,
    reason: options.reason,
    ...(options.expectedHead === null
      ? { expectedHead: null, enforceExpectedHead: true }
      : { expectedHead: options.expectedHead })
  })
  const critical = Effect.gen(function* () {
    const prepared = yield* prepare(storage, head, changeSet)
    if (prepared.kind === PREPARED_KIND.replayed) return prepared.result
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

const PREPARED_KIND = { replayed: "replayed", prepared: "prepared" } as const

type Prepared =
  | { readonly kind: typeof PREPARED_KIND.replayed; readonly result: CommitResult }
  | {
      readonly kind: typeof PREPARED_KIND.prepared
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
      kind: PREPARED_KIND.replayed,
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
  return { kind: PREPARED_KIND.prepared, identity, oldHead, before, applied }
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
  prepared: Extract<Prepared, { readonly kind: typeof PREPARED_KIND.prepared }>
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
