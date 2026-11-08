import { Effect } from "effect"

import {
  parseIdempotencyRecord,
  parseTransaction,
  type Transaction
} from "../domain/transaction.js"
import { validateSnapshotTransition } from "../domain/integrity.js"
import { materializationRows } from "../domain/change-set.js"
import { parseCommitObject } from "../domain/codec.js"
import { normalizeRelativePath } from "../domain/model.js"
import {
  CorruptRepositoryError,
  IdempotencyConflictError,
  RevisionConflictError
} from "../domain/errors.js"
import { canonicalJsonl } from "../domain/format.js"
import { currentMap, materializeTree, validHash, type RepositoryError } from "./state.js"
import type { RevisionStorageShape } from "../storage/service.js"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

const readTransaction = Effect.fn("RevisionTransaction.readTransaction")(function* (
  storage: RevisionStorageShape,
  id: string
): Effect.fn.Return<Transaction, RepositoryError> {
  for (const directory of ["publish", "backups", "displaced", "rejected", "markers"]) {
    yield* storage.listMetadata(`transactions/${id}/${directory}`)
  }
  const content = yield* storage.readMetadata(`transactions/${id}/manifest.jsonl`)
  if (content === null)
    return yield* new CorruptRepositoryError({ message: `transaction manifest is missing: ${id}` })
  return yield* parseTransaction(id, content)
})

const hasMarker = (
  storage: RevisionStorageShape,
  id: string,
  marker: string
): Effect.Effect<boolean, RepositoryError> =>
  storage
    .readMetadata(
      `transactions/${id}/${marker === "PREPARED" ? marker : `markers/${marker}`}`,
      true
    )
    .pipe(
      Effect.flatMap((content) => {
        if (content === null) return Effect.succeed(false)
        return content.length === 0
          ? Effect.succeed(true)
          : Effect.fail(
              new CorruptRepositoryError({
                message: `transaction marker is not an empty file: ${id}/${marker}`
              })
            )
      })
    )

export const writeIdempotencyRecord = (
  storage: RevisionStorageShape,
  keyHash: string,
  requestHash: string,
  commitId: string
): Effect.Effect<void, RepositoryError> => {
  const content = canonicalJsonl({
    version: 2,
    key_hash: keyHash,
    request_hash: requestHash,
    commit_id: commitId
  })
  return storage.writeIdempotency(keyHash, content).pipe(
    Effect.catchTag(
      "RevisionConflictError",
      Effect.fn("RevisionTransaction.writeIdempotencyRecord.conflict")(function* () {
        const existing = yield* storage.readIdempotency(keyHash)
        if (existing === null)
          return yield* new CorruptRepositoryError({
            message: `idempotency record disappeared: ${keyHash}`
          })
        const record = yield* parseIdempotencyRecord(existing, keyHash)
        if (record.requestHash !== requestHash || record.commitId !== commitId)
          return yield* new IdempotencyConflictError({
            message: `idempotency record conflicts: ${keyHash}`
          })
      })
    )
  )
}

export const artifact = (id: string, kind: string, index: number): string =>
  `transactions/${id}/${kind}/${index.toString().padStart(4, "0")}`

const contentHash = (content: Uint8Array | null): string | null =>
  content === null ? null : sha256Hex(content)

export const workingHash = (
  storage: RevisionStorageShape,
  path: string
): Effect.Effect<string | null, RepositoryError> =>
  storage.readWorking(path, true, true).pipe(Effect.map(contentHash))

export const assertWorking = Effect.fn("RevisionTransaction.assertWorking")(function* (
  storage: RevisionStorageShape,
  path: string,
  expected: string | null
): Effect.fn.Return<void, RepositoryError> {
  const actual = yield* workingHash(storage, path)
  if (actual !== expected)
    return yield* new RevisionConflictError({ message: `working file changed: ${path}` })
})

export const installRows = Effect.fn("RevisionTransaction.installRows")(function* (
  storage: RevisionStorageShape,
  transaction: Transaction,
  expectPreinstalled = false
): Effect.fn.Return<void, RepositoryError> {
  for (const [index, row] of transaction.rows.entries()) {
    const expected = row.newBlob
    const current = yield* workingHash(storage, row.path)
    if (expectPreinstalled) {
      if (expected === null || current !== expected) {
        return yield* new RevisionConflictError({
          message: `adopted working file changed during transaction: ${row.path}`
        })
      }
      continue
    }
    const baseline = row.oldBlob
    const displacement = artifact(transaction.transactionId, "displaced", index)
    const displaced = (yield* storage.readMetadata(displacement, true)) !== null
    if (current === expected) continue
    if (current !== baseline && !(current === null && displaced)) {
      return yield* new RevisionConflictError({
        message: `working file changed during transaction: ${row.path}`
      })
    }
    if (current === baseline && baseline !== null) {
      if (displaced)
        return yield* new RevisionConflictError({
          message: `working file changed during transaction: ${row.path}`
        })
      yield* storage.moveWorkingToMetadata(row.path, displacement)
      const moved = yield* storage.readMetadata(displacement)
      if (moved === null || sha256Hex(moved) !== baseline) {
        if (moved !== null && (yield* workingHash(storage, row.path)) === null) {
          yield* storage.writeWorking(row.path, moved, true).pipe(
            Effect.catchTags({
              RevisionConflictError: () => Effect.void,
              UnsafePathError: () => Effect.void
            })
          )
        }
        return yield* new RevisionConflictError({
          message: `working file changed during displacement: ${row.path}`
        })
      }
    } else if (displaced) {
      if (baseline === null)
        return yield* new CorruptRepositoryError({
          message: `transaction has an unexpected displacement: ${row.path}`
        })
      const moved = yield* storage.readMetadata(displacement)
      if (moved === null || sha256Hex(moved) !== baseline) {
        return yield* new CorruptRepositoryError({
          message: `transaction displacement is invalid: ${row.path}`
        })
      }
    }
    if (expected === null) continue
    const source = artifact(transaction.transactionId, "publish", index)
    const content = yield* storage.readMetadata(source)
    if (content === null || sha256Hex(content) !== expected)
      return yield* new CorruptRepositoryError({
        message: `transaction artifact is invalid: ${row.path}`
      })
    if ((yield* workingHash(storage, row.path)) !== expected) {
      yield* storage.writeWorking(row.path, content, true)
      if ((yield* workingHash(storage, row.path)) !== expected) {
        return yield* new RevisionConflictError({
          message: `working file changed during install: ${row.path}`
        })
      }
    }
  }
})

interface WorkingObservation {
  readonly hash: string | null
  readonly conflicted: boolean
}

const observeWorking = (
  storage: RevisionStorageShape,
  path: string
): Effect.Effect<WorkingObservation, RepositoryError> =>
  storage.readWorking(path, true, false).pipe(
    Effect.map((content): WorkingObservation => ({
      hash: contentHash(content),
      conflicted: false
    })),
    Effect.catchTags({
      RevisionConflictError: (): Effect.Effect<WorkingObservation> =>
        Effect.succeed({ hash: null, conflicted: true }),
      UnsafePathError: (): Effect.Effect<WorkingObservation> =>
        Effect.succeed({ hash: null, conflicted: true })
    })
  )

const tryWriteWorking = (
  storage: RevisionStorageShape,
  path: string,
  content: Uint8Array
): Effect.Effect<boolean, RepositoryError> =>
  storage.writeWorking(path, content, true).pipe(
    Effect.as(true),
    Effect.catchTags({
      RevisionConflictError: () => Effect.succeed(false),
      UnsafePathError: () => Effect.succeed(false)
    })
  )

const moveTransactionToConflicts = Effect.fn("RevisionTransaction.moveTransactionToConflicts")(
  function* (
    storage: RevisionStorageShape,
    transactionId: string
  ): Effect.fn.Return<void, RepositoryError> {
    if (!(yield* hasMarker(storage, transactionId, "CONFLICT"))) {
      yield* storage.writeMetadata(
        `transactions/${transactionId}/markers/CONFLICT`,
        new Uint8Array(),
        true
      )
    }
    if (yield* storage.metadataExists(`conflicts/${transactionId}`)) {
      return yield* new CorruptRepositoryError({
        message: `conflict transaction already exists: ${transactionId}`
      })
    }
    yield* storage.renameMetadataDirectory(
      `transactions/${transactionId}`,
      `conflicts/${transactionId}`
    )
  }
)

const rollbackTransaction = Effect.fn("RevisionTransaction.rollbackTransaction")(function* (
  storage: RevisionStorageShape,
  transaction: Transaction
): Effect.fn.Return<void, RepositoryError> {
  let conflicted = false
  for (const [index, row] of [...transaction.rows.entries()].reverse()) {
    let observed = yield* observeWorking(storage, row.path)
    conflicted ||= observed.conflicted
    if (row.newBlob !== null && !observed.conflicted && observed.hash === row.newBlob) {
      const rejected = artifact(transaction.transactionId, "rejected", index)
      if (yield* storage.metadataExists(rejected)) {
        conflicted = true
      } else {
        const moved = yield* storage.moveWorkingToMetadata(row.path, rejected).pipe(
          Effect.as(true),
          Effect.catchTags({
            RevisionConflictError: () => Effect.succeed(false),
            UnsafePathError: () => Effect.succeed(false)
          })
        )
        if (!moved) {
          conflicted = true
        } else {
          const rejectedContent = yield* storage.readMetadata(rejected)
          if (rejectedContent === null || sha256Hex(rejectedContent) !== row.newBlob) {
            conflicted = true
            if (
              (yield* observeWorking(storage, row.path)).hash === null &&
              rejectedContent !== null
            ) {
              yield* tryWriteWorking(storage, row.path, rejectedContent)
            }
          }
        }
      }
      observed = yield* observeWorking(storage, row.path)
      conflicted ||= observed.conflicted
    }
    if (row.oldBlob === null) {
      if (observed.hash !== null || observed.conflicted) conflicted = true
      continue
    }
    if (observed.hash === row.oldBlob && !observed.conflicted) continue
    if (observed.hash !== null || observed.conflicted) {
      conflicted = true
      continue
    }
    const displaced = artifact(transaction.transactionId, "displaced", index)
    const source = (yield* storage.metadataExists(displaced))
      ? displaced
      : artifact(transaction.transactionId, "backups", index)
    const content = yield* storage.readMetadata(source)
    if (content === null || sha256Hex(content) !== row.oldBlob) {
      return yield* new CorruptRepositoryError({
        message: `transaction restore artifact is invalid: ${row.path}`
      })
    }
    if (!(yield* tryWriteWorking(storage, row.path, content))) conflicted = true
  }

  const previous = yield* currentMap(storage, transaction.oldHead)
  for (const version of previous.values()) {
    if (version.state !== "active") continue
    const observed = yield* observeWorking(storage, version.path)
    if (observed.conflicted || observed.hash !== version.blobId) conflicted = true
  }
  if (conflicted) {
    yield* moveTransactionToConflicts(storage, transaction.transactionId)
    return
  }
  if (!(yield* hasMarker(storage, transaction.transactionId, "ROLLED_BACK"))) {
    yield* storage.writeMetadata(
      `transactions/${transaction.transactionId}/markers/ROLLED_BACK`,
      new Uint8Array(),
      true
    )
  }
  yield* storage.removeMetadataTree(`transactions/${transaction.transactionId}`)
})

/** Validate every active path in a resulting tree before publishing or deleting recovery metadata. */
export const validateWorkingTree = Effect.fn("RevisionTransaction.validateWorkingTree")(function* (
  storage: RevisionStorageShape,
  head: string
): Effect.fn.Return<void, RepositoryError> {
  const snapshot = yield* currentMap(storage, head)
  for (const version of snapshot.values()) {
    if (version.state !== "active") continue
    const observed = yield* observeWorking(storage, version.path)
    if (observed.conflicted || observed.hash !== version.blobId) {
      return yield* new RevisionConflictError({
        message: `working tree does not match resulting tree: ${version.path}`
      })
    }
  }
})

/**
 * Settle interrupted transactions. Only the transactions directory is swept
 * for crash-orphaned temporaries here, because recovery lists it and nothing
 * else: this runs before every commit, and sweeping the whole history
 * (thousands of objects) each time cost seconds per boot. The rest of the
 * history is swept once per open, and before maintenance lists objects.
 */
export const recoverTransactions = Effect.fn("recoverRevisionTransactions")(function* (
  storage: RevisionStorageShape
): Effect.fn.Return<void, RepositoryError> {
  yield* storage.cleanupMetadataTemps("transactions")
  const names = yield* storage.listMetadata("transactions")
  for (const id of [...names].sort(compareCodePoints)) {
    if (!validHash(id))
      return yield* new CorruptRepositoryError({ message: `invalid transaction directory: ${id}` })
    const prepared = yield* hasMarker(storage, id, "PREPARED")
    if (!prepared) {
      yield* storage.removeMetadataTree(`transactions/${id}`)
      continue
    }
    const transaction = yield* readTransaction(storage, id)
    const decided = yield* hasMarker(storage, id, "DECIDED")
    const committed = yield* hasMarker(storage, id, "COMMITTED")
    const adopting = yield* hasMarker(storage, id, "ADOPTING")
    const semanticsOk = yield* validateTransactionSemantics(storage, transaction).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        quarantineUndecidedPrepare(storage, transaction, { decided, committed }, error)
      )
    )
    if (!semanticsOk) continue
    const current = yield* storage.readRef
    if (decided || committed || adopting || current === transaction.newHead) {
      if (current !== transaction.oldHead && current !== transaction.newHead) {
        return yield* new CorruptRepositoryError({
          message: `decided transaction ${id} found unexpected current ref`
        })
      }
      const materialize = Effect.gen(function* () {
        yield* installRows(storage, transaction, adopting)
        yield* validateWorkingTree(storage, transaction.newHead)
      })
      const ready = yield* materialize.pipe(
        Effect.as(true),
        Effect.catch(
          Effect.fn("RevisionTransaction.materializeFailed")(function* (error) {
            if (
              adopting &&
              !decided &&
              !committed &&
              (error._tag === "RevisionConflictError" || error._tag === "UnsafePathError") &&
              (current === transaction.oldHead || current === transaction.newHead)
            ) {
              if (current === transaction.newHead) {
                yield* storage.compensateRef(transaction.newHead, transaction.oldHead)
              }
              yield* moveTransactionToConflicts(storage, transaction.transactionId)
              return false
            }
            if (
              !decided &&
              current === transaction.newHead &&
              (error._tag === "RevisionConflictError" || error._tag === "UnsafePathError")
            ) {
              yield* storage.compensateRef(transaction.newHead, transaction.oldHead)
            }
            return yield* Effect.fail(error)
          })
        )
      )
      if (!ready) continue
      if (current === transaction.oldHead)
        yield* storage.compareAndSwapRef(transaction.oldHead, transaction.newHead)
      yield* storage.publish(transaction.newHead).pipe(
        Effect.catchTag("RevisionConflictError", () =>
          storage.isPublished(transaction.newHead).pipe(
            Effect.flatMap((published) =>
              published
                ? Effect.succeed(undefined)
                : Effect.fail(
                    new CorruptRepositoryError({
                      message: `publication marker is invalid: ${transaction.newHead}`
                    })
                  )
            )
          )
        )
      )
      yield* writeIdempotencyRecord(
        storage,
        transaction.keyHash,
        transaction.requestHash,
        transaction.newHead
      )
      yield* storage.removeMetadataTree(`transactions/${id}`)
    } else if (current === transaction.oldHead) {
      yield* rollbackTransaction(storage, transaction)
    } else {
      return yield* new CorruptRepositoryError({
        message: `transaction ${id} found unexpected current ref`
      })
    }
  }
})

const quarantineUndecidedPrepare = Effect.fn("RevisionTransaction.quarantineUndecidedPrepare")(
  function* (
    storage: RevisionStorageShape,
    transaction: Transaction,
    markers: { readonly decided: boolean; readonly committed: boolean },
    error: RepositoryError
  ): Effect.fn.Return<boolean, RepositoryError> {
    const ref = yield* storage.readRef
    if (!markers.decided && !markers.committed && ref === transaction.oldHead) {
      yield* moveTransactionToConflicts(storage, transaction.transactionId)
      return false
    }
    return yield* Effect.fail(error)
  }
)

declare const validatedBeforePrepare: unique symbol
export type ValidatedTransaction = Transaction & { readonly [validatedBeforePrepare]: true }

export const validateBeforePrepare = (
  storage: RevisionStorageShape,
  transaction: Transaction
): Effect.Effect<ValidatedTransaction, RepositoryError> =>
  Effect.as(validateTransactionSemantics(storage, transaction), transaction as ValidatedTransaction)

export const writePreparedMarker = (
  storage: RevisionStorageShape,
  transaction: ValidatedTransaction
) =>
  storage.writeMetadata(
    `transactions/${transaction.transactionId}/PREPARED`,
    new Uint8Array(),
    true
  )

const validateTransactionSemantics = Effect.fn("RevisionTransaction.validateTransactionSemantics")(
  function* (
    storage: RevisionStorageShape,
    transaction: Transaction
  ): Effect.fn.Return<void, RepositoryError> {
    const commitBytes = yield* storage.readCommit(transaction.newHead)
    const commit = yield* parseCommitObject(transaction.newHead, commitBytes)
    if (commit.parentId !== transaction.oldHead || commit.treeId !== transaction.treeId) {
      return yield* new CorruptRepositoryError({
        message: `transaction ${transaction.transactionId} does not match its commit`
      })
    }
    const before = yield* currentMap(storage, transaction.oldHead)
    const after = yield* materializeTree(storage, transaction.treeId)
    yield* validateSnapshotTransition(commit, before, after)
    const expected = yield* materializationRows(before, after)
    if (
      expected.length !== transaction.rows.length ||
      expected.some((row, index) => {
        const actual = transaction.rows[index]
        return (
          actual === undefined ||
          row.path !== actual.path ||
          row.oldBlob !== actual.oldBlob ||
          row.newBlob !== actual.newBlob
        )
      })
    )
      return yield* new CorruptRepositoryError({
        message: `transaction ${transaction.transactionId} rows do not match its tree delta`
      })
    for (const [index, row] of transaction.rows.entries()) {
      yield* normalizeRelativePath(row.path).pipe(
        Effect.mapError(
          () =>
            new CorruptRepositoryError({
              message: `transaction ${transaction.transactionId} has an unsafe path`
            })
        )
      )
      if (row.oldBlob !== null) {
        const backup = yield* storage.readMetadata(
          artifact(transaction.transactionId, "backups", index)
        )
        if (backup === null || sha256Hex(backup) !== row.oldBlob) {
          return yield* new CorruptRepositoryError({
            message: `transaction backup is invalid: ${row.path}`
          })
        }
      }
      if (row.newBlob !== null) {
        const publish = yield* storage.readMetadata(
          artifact(transaction.transactionId, "publish", index)
        )
        if (publish === null || sha256Hex(publish) !== row.newBlob) {
          return yield* new CorruptRepositoryError({
            message: `transaction publish artifact is invalid: ${row.path}`
          })
        }
      }
    }
  }
)
