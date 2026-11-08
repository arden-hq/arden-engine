import { Effect, Schema } from "effect"

import { decodeCanonicalJsonl } from "./codec.js"
import { normalizeRelativePath } from "./model.js"
import { CorruptRepositoryError } from "./errors.js"
import { type JsonRecord } from "./format.js"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const NonEmptyText = Schema.String.check(Schema.isMinLength(1))

const IdempotencyRecord = Schema.Struct({
  commit_id: Hash,
  key_hash: Hash,
  request_hash: Hash,
  version: Schema.Literal(2)
})

const TransactionRowRecord = Schema.Struct({
  new_blob: Schema.NullOr(Hash),
  old_blob: Schema.NullOr(Hash),
  path: NonEmptyText
})

const TransactionRecord = Schema.Struct({
  key_hash: Hash,
  kind: Schema.Literal("transaction"),
  new_head: Hash,
  old_head: Schema.NullOr(Hash),
  request_hash: Hash,
  rows: Schema.Array(TransactionRowRecord),
  tree_id: Hash,
  version: Schema.Literal(2)
})

interface TransactionRow {
  readonly path: string
  readonly oldBlob: string | null
  readonly newBlob: string | null
}

export interface Transaction {
  readonly transactionId: string
  readonly oldHead: string | null
  readonly newHead: string
  readonly treeId: string
  readonly keyHash: string
  readonly requestHash: string
  readonly rows: readonly TransactionRow[]
}

export const transactionRecord = (transaction: Omit<Transaction, "transactionId">): JsonRecord => ({
  version: 2,
  kind: "transaction",
  old_head: transaction.oldHead,
  new_head: transaction.newHead,
  tree_id: transaction.treeId,
  key_hash: transaction.keyHash,
  request_hash: transaction.requestHash,
  rows: transaction.rows.map((row) => ({
    path: row.path,
    old_blob: row.oldBlob,
    new_blob: row.newBlob
  }))
})

export const parseIdempotencyRecord = Effect.fn("Revision.parseIdempotencyRecord")(function* (
  content: Uint8Array,
  keyHash: string
): Effect.fn.Return<
  { readonly keyHash: string; readonly requestHash: string; readonly commitId: string },
  CorruptRepositoryError
> {
  const record = yield* decodeCanonicalJsonl(content)
  const decoded = yield* Schema.decodeUnknownEffect(IdempotencyRecord)(record, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError(
      () =>
        new CorruptRepositoryError({
          message: `idempotency record ${keyHash} has an invalid shape`
        })
    )
  )
  if (decoded.key_hash !== keyHash)
    return yield* new CorruptRepositoryError({
      message: `idempotency record ${keyHash} has the wrong key hash`
    })
  return { keyHash, requestHash: decoded.request_hash, commitId: decoded.commit_id }
})

export const parseTransaction = Effect.fn("Revision.parseTransaction")(function* (
  transactionId: string,
  content: Uint8Array
): Effect.fn.Return<Transaction, CorruptRepositoryError> {
  if (sha256Hex(content) !== transactionId)
    return yield* new CorruptRepositoryError({
      message: `transaction ${transactionId} failed its manifest hash`
    })
  const record = yield* decodeCanonicalJsonl(content)
  const decoded = yield* Schema.decodeUnknownEffect(TransactionRecord)(record, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError(
      () =>
        new CorruptRepositoryError({ message: `transaction ${transactionId} has an invalid shape` })
    )
  )
  const rows: TransactionRow[] = []
  let previousPath: string | undefined
  for (const row of decoded.rows) {
    const normalized = yield* normalizeRelativePath(row.path).pipe(
      Effect.mapError(
        () =>
          new CorruptRepositoryError({ message: `transaction ${transactionId} has an unsafe path` })
      )
    )
    if (
      normalized !== row.path ||
      (previousPath !== undefined && compareCodePoints(previousPath, row.path) >= 0)
    )
      return yield* new CorruptRepositoryError({
        message: `transaction ${transactionId} rows are not uniquely ordered`
      })
    if (row.old_blob === row.new_blob)
      return yield* new CorruptRepositoryError({
        message: `transaction ${transactionId} row makes no change`
      })
    rows.push({ path: row.path, oldBlob: row.old_blob, newBlob: row.new_blob })
    previousPath = row.path
  }
  return {
    transactionId,
    oldHead: decoded.old_head,
    newHead: decoded.new_head,
    treeId: decoded.tree_id,
    keyHash: decoded.key_hash,
    requestHash: decoded.request_hash,
    rows
  }
})
