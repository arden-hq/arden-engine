import { Effect, Result } from "effect"

import { Commit, ResourceVersion, isActive, normalizeRelativePath } from "../domain/model.js"
import { CorruptRepositoryError, InvalidRevisionInputError } from "../domain/errors.js"
import { OBJECT_KIND, OBJECT_KINDS, type ObjectKind, type TreeRecord } from "../domain/format.js"
import { isJsonlObject } from "./objects.js"
import { corrupt, makeReader, validHash, type MaintenanceReader } from "./maintenance-reader.js"
import { errorMessage } from "@arden-hq/std/errors"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  type IntegrityIssue,
  type IntegrityReport,
  type MaintenanceError,
  type MaintenanceObjectEntry,
  type MaintenanceProtectedTransaction,
  type MaintenanceStorage,
  type StorageReport
} from "./maintenance-types.js"

export const invalidInput = (message: string): Effect.Effect<never, InvalidRevisionInputError> =>
  Effect.fail(new InvalidRevisionInputError({ message }))

export const validateTransaction = Effect.fn("maintenance.validateTransaction")(function* (
  transaction: MaintenanceProtectedTransaction
): Effect.fn.Return<void, CorruptRepositoryError> {
  if (
    !validHash(transaction.transactionId) ||
    !validHash(transaction.newHead) ||
    (transaction.oldHead !== null && !validHash(transaction.oldHead)) ||
    !validHash(transaction.treeId)
  )
    return yield* corrupt(`transaction ${transaction.transactionId} has invalid roots`)
  let previousPath: string | null = null
  for (const [index, row] of transaction.rows.entries()) {
    const normalized = yield* normalizeRelativePath(row.path).pipe(
      Effect.mapError(
        (error) =>
          new CorruptRepositoryError({
            message: `transaction ${transaction.transactionId} row ${index} has an invalid path: ${errorMessage(error)}`
          })
      )
    )
    if (
      normalized !== row.path ||
      (previousPath !== null && compareCodePoints(previousPath, row.path) >= 0)
    ) {
      return yield* corrupt(`transaction ${transaction.transactionId} row ${index} is not ordered`)
    }
    if (row.oldBlob === null && row.newBlob === null) {
      return yield* corrupt(`transaction ${transaction.transactionId} row ${index} makes no change`)
    }
    if (
      (row.oldBlob !== null && !validHash(row.oldBlob)) ||
      (row.newBlob !== null && !validHash(row.newBlob))
    ) {
      return yield* corrupt(
        `transaction ${transaction.transactionId} row ${index} has an invalid blob`
      )
    }
    if (row.oldBlob === row.newBlob)
      return yield* corrupt(`transaction ${transaction.transactionId} row ${index} makes no change`)
    previousPath = row.path
  }
  return
})

const jsonlStem = (filename: string): string =>
  filename.endsWith(".jsonl") ? filename.slice(0, -6) : ""

export const objectIdFromFilenameUnsafe = (filename: string, jsonl: boolean): string => {
  const name = jsonl ? jsonlStem(filename) : filename
  if (!validHash(name))
    throw new CorruptRepositoryError({ message: `object filename is invalid: ${filename}` })
  return name
}

const addResultIssue = <A>(
  value: Result.Result<A, unknown>,
  issues: IntegrityIssue[],
  target: string,
  code = "repository_corrupt"
): A | null => {
  if (Result.isSuccess(value)) return value.success
  issues.push({ code, target, detail: errorMessage(value.failure) })
  return null
}

const listObjectEntries = Effect.fn("maintenance.listObjectEntries")(function* (
  storage: MaintenanceStorage,
  kind: ObjectKind,
  issues: IntegrityIssue[]
): Effect.fn.Return<ReadonlyArray<MaintenanceObjectEntry>, never> {
  const result = yield* Effect.result(storage.listObjects(kind))
  return Result.isSuccess(result)
    ? result.success
    : (issues.push({
        code: "repository_corrupt",
        target: kind,
        detail: errorMessage(result.failure)
      }),
      [])
})

const validateObjectEntryWithIssues = Effect.fn("maintenance.validateObjectEntryWithIssues")(
  function* (
    storage: MaintenanceStorage,
    reader: MaintenanceReader,
    kind: ObjectKind,
    entry: MaintenanceObjectEntry,
    issues: IntegrityIssue[]
  ): Effect.fn.Return<void, never> {
    const jsonl = isJsonlObject(kind)
    const parsed = yield* Effect.result(
      Effect.try({
        try: () => objectIdFromFilenameUnsafe(entry.name, jsonl),
        catch: (error) =>
          error instanceof CorruptRepositoryError
            ? error
            : new CorruptRepositoryError({ message: errorMessage(error) })
      })
    )
    if (Result.isFailure(parsed)) {
      issues.push({
        code: `${kind}_corrupt`,
        target: entry.name,
        detail: errorMessage(parsed.failure)
      })
      return
    }
    const id = parsed.success
    const content = yield* Effect.result(storage.readObject(kind, id))
    if (Result.isFailure(content)) {
      issues.push({
        code: `${kind}_corrupt`,
        target: entry.name,
        detail: errorMessage(content.failure)
      })
      return
    }
    if (sha256Hex(content.success) !== id) {
      issues.push({
        code: `${kind}_corrupt`,
        target: entry.name,
        detail: `${kind} hash mismatch: ${id}`
      })
      return
    }
    if (kind === OBJECT_KIND.blob) return
    const parse: Effect.Effect<TreeRecord | Commit, MaintenanceError> =
      kind === OBJECT_KIND.tree ? reader.tree(id) : reader.commit(id)
    const parsedObject = yield* Effect.result(parse)
    if (Result.isFailure(parsedObject)) {
      issues.push({
        code: `${kind}_corrupt`,
        target: entry.name,
        detail: errorMessage(parsedObject.failure)
      })
    }
  }
)

export const integrityReport = Effect.fn("integrityReport")(function* (
  storage: MaintenanceStorage
): Effect.fn.Return<IntegrityReport, never> {
  const issues: IntegrityIssue[] = []
  const reader = makeReader(storage)
  const entries = new Map<ObjectKind, ReadonlyArray<MaintenanceObjectEntry>>()
  let objectCount = 0
  for (const kind of OBJECT_KINDS) {
    const values = yield* listObjectEntries(storage, kind, issues)
    entries.set(kind, values)
    objectCount += values.length
    for (const entry of values) {
      yield* validateObjectEntryWithIssues(storage, reader, kind, entry, issues)
    }
  }

  const headResult = yield* Effect.result(storage.readRef)
  const rawHead = addResultIssue(headResult, issues, "current-ref")
  const head: string | null = rawHead
  const publishedResult = yield* Effect.result(storage.listPublished)
  const publishedIds = new Set<string>()
  const published = addResultIssue(publishedResult, issues, "published", "publication_corrupt")
  if (published !== null) {
    for (const marker of published) {
      if (!validHash(marker.commitId)) {
        issues.push({
          code: "publication_corrupt",
          target: marker.commitId,
          detail: "published commit marker is invalid"
        })
      } else {
        publishedIds.add(marker.commitId)
      }
    }
  }

  let resources = new Map<string, ResourceVersion>()
  const reachableCommits = new Set<string>()
  if (head !== null && validHash(head)) {
    if (published !== null && !publishedIds.has(head)) {
      issues.push({
        code: "repository_corrupt",
        target: head,
        detail: "current ref points to an unpublished commit"
      })
    }
    let cursor: string | null = head
    while (cursor !== null) {
      if (reachableCommits.has(cursor)) {
        issues.push({
          code: "repository_corrupt",
          target: cursor,
          detail: `commit history contains a cycle at ${cursor}`
        })
        break
      }
      reachableCommits.add(cursor)
      const commitResult: Result.Result<Commit, MaintenanceError> = yield* Effect.result(
        reader.commit(cursor)
      )
      if (Result.isFailure(commitResult)) {
        issues.push({
          code: "repository_corrupt",
          target: cursor,
          detail: errorMessage(commitResult.failure)
        })
        break
      }
      const transitionResult = yield* Effect.result(reader.transition(commitResult.success))
      if (Result.isFailure(transitionResult)) {
        issues.push({
          code: "repository_corrupt",
          target: cursor,
          detail: errorMessage(transitionResult.failure)
        })
        break
      }
      if (cursor === head) resources = new Map(transitionResult.success)
      cursor = commitResult.success.parentId
    }
    for (const resource of resources.values()) {
      if (!isActive(resource)) continue
      const working = yield* Effect.result(storage.readWorking(resource.path))
      if (Result.isFailure(working)) {
        issues.push({
          code: "repository_corrupt",
          target: resource.path,
          detail: errorMessage(working.failure)
        })
      } else {
        const actual = working.success === null ? null : sha256Hex(working.success)
        if (actual !== resource.blobId) {
          issues.push({
            code: "managed_file_mismatch",
            target: resource.path,
            detail: `working file changed: ${resource.path}`
          })
        }
      }
    }
  } else if (head !== null) {
    issues.push({
      code: "repository_corrupt",
      target: "current-ref",
      detail: "current ref has an invalid commit identifier"
    })
  }

  if (published !== null) {
    for (const commitId of [...reachableCommits].sort(compareCodePoints)) {
      if (!publishedIds.has(commitId)) {
        issues.push({
          code: "publication_missing",
          target: commitId,
          detail: "reachable commit lacks its publication certificate"
        })
      }
    }
    for (const commitId of [...publishedIds].sort(compareCodePoints)) {
      if (!reachableCommits.has(commitId)) {
        issues.push({
          code: "publication_corrupt",
          target: commitId,
          detail: "published commit marker points outside current history"
        })
      }
    }
  }

  const idempotencyResult = yield* Effect.result(storage.listIdempotency)
  const idempotency = addResultIssue(
    idempotencyResult,
    issues,
    "idempotency",
    "idempotency_corrupt"
  )
  if (idempotency !== null) {
    for (const record of idempotency) {
      if (
        !validHash(record.keyHash) ||
        !validHash(record.requestHash) ||
        !validHash(record.commitId)
      ) {
        issues.push({
          code: "idempotency_corrupt",
          target: record.keyHash,
          detail: "idempotency record has invalid identifiers"
        })
      } else if (!reachableCommits.has(record.commitId)) {
        issues.push({
          code: "idempotency_corrupt",
          target: record.keyHash,
          detail: "idempotency record points outside published history"
        })
      }
    }
  }

  const transactionsResult = yield* Effect.result(storage.listProtectedTransactions)
  const transactions = addResultIssue(
    transactionsResult,
    issues,
    "transactions",
    "recovery_corrupt"
  )
  if (transactions !== null) {
    for (const transaction of transactions) {
      const checked = yield* Effect.result(validateTransaction(transaction))
      if (Result.isFailure(checked)) {
        issues.push({
          code: "recovery_corrupt",
          target: transaction.transactionId,
          detail: errorMessage(checked.failure)
        })
      } else if (transaction.conflicted === true) {
        issues.push({
          code: "recovery_conflict",
          target: transaction.transactionId,
          detail: "an external write prevented automatic rollback"
        })
      }
    }
  }

  return {
    ok: issues.length === 0,
    headCommit: head,
    resources: resources.size,
    objects: objectCount,
    issues
  }
})

const countResources = (
  resources: ReadonlyMap<string, ResourceVersion> | ReadonlyArray<ResourceVersion> | number
): number => {
  if (typeof resources === "number") return resources
  return "size" in resources ? resources.size : resources.length
}

export const storageReport = Effect.fn("storageReport")(function* (
  storage: MaintenanceStorage,
  resources: ReadonlyMap<string, ResourceVersion> | ReadonlyArray<ResourceVersion> | number = 0
): Effect.fn.Return<StorageReport, MaintenanceError> {
  const values: Record<ObjectKind, ReadonlyArray<MaintenanceObjectEntry>> = {
    blob: yield* storage.listObjects(OBJECT_KIND.blob),
    tree: yield* storage.listObjects(OBJECT_KIND.tree),
    commit: yield* storage.listObjects(OBJECT_KIND.commit)
  }
  const metadata = yield* storage.metadataStats
  if (metadata.lockBytes === null)
    return yield* corrupt("repository lock disappeared during storage reporting")
  const allStats = [
    metadata.transactionBytes,
    metadata.conflictBytes,
    metadata.idempotencyBytes,
    metadata.publicationBytes,
    metadata.refBytes,
    metadata.lockBytes
  ]
  if (allStats.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return yield* corrupt("storage metadata contains an invalid byte count")
  }
  const bytes = (kind: ObjectKind): number =>
    values[kind].reduce((total, entry) => total + entry.byteSize, 0)
  const blobBytes = bytes(OBJECT_KIND.blob)
  const treeBytes = bytes(OBJECT_KIND.tree)
  const commitBytes = bytes(OBJECT_KIND.commit)
  const recoveryBytes = metadata.transactionBytes + metadata.conflictBytes
  const metadataBytes =
    metadata.idempotencyBytes + metadata.publicationBytes + metadata.refBytes + metadata.lockBytes
  const resourceCount = countResources(resources)
  return {
    totalBytes: blobBytes + treeBytes + commitBytes + recoveryBytes + metadataBytes,
    blobBytes,
    treeBytes,
    commitBytes,
    recoveryBytes,
    metadataBytes,
    resourceCount,
    commitCount: values.commit.length,
    objectCount: OBJECT_KINDS.reduce((total, kind) => total + values[kind].length, 0)
  }
})
