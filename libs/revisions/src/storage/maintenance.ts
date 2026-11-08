import { Clock, Effect, Result } from "effect"

import { Commit, ResourceVersion, normalizeRelativePath } from "../domain/model.js"
import {
  CorruptRepositoryError,
  InvalidRevisionInputError,
  RevisionStorageError,
  UnsafePathError
} from "../domain/errors.js"
import { type TreeRecord } from "../domain/format.js"
import { corrupt, makeReader, validHash, type MaintenanceReader } from "./maintenance-reader.js"
import { errorMessage } from "@arden-hq/std/errors"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

/** Object families owned by the revisions store. */
export type MaintenanceObjectKind = "blob" | "tree" | "commit"

/** One object-directory entry as observed by a storage adapter. */
export interface MaintenanceObjectEntry {
  readonly name: string
  readonly byteSize: number
  readonly modifiedAtMillis: number
}

interface MaintenancePublishedEntry {
  readonly commitId: string
}

/** A validated idempotency record used as a collection root. */
export interface MaintenanceIdempotencyRecord {
  readonly keyHash: string
  readonly requestHash: string
  readonly commitId: string
}

interface MaintenanceTransactionRow {
  readonly path: string
  readonly oldBlob: string | null
  readonly newBlob: string | null
}

/** A validated pending or conflict transaction supplied by the repository adapter. */
export interface MaintenanceProtectedTransaction {
  readonly transactionId: string
  readonly oldHead: string | null
  readonly newHead: string
  readonly treeId: string
  readonly rows: ReadonlyArray<MaintenanceTransactionRow>
  /** True when the manifest came from conflicts/ after an external-write conflict. */
  readonly conflicted?: boolean
}

/** Byte counts for metadata outside immutable object directories. */
export interface MaintenanceMetadataStats {
  readonly transactionBytes: number
  readonly conflictBytes: number
  readonly idempotencyBytes: number
  readonly publicationBytes: number
  readonly refBytes: number
  readonly lockBytes: number | null
}

/** Errors an adapter may return while maintenance is reading or sweeping. */
export type MaintenanceStorageError =
  | CorruptRepositoryError
  | RevisionStorageError
  | UnsafePathError

/** Small adapter boundary for integrity checks, accounting, and collection. */
export interface MaintenanceStorage {
  readonly readRef: Effect.Effect<string | null, MaintenanceStorageError>
  readonly listObjects: (
    kind: MaintenanceObjectKind
  ) => Effect.Effect<ReadonlyArray<MaintenanceObjectEntry>, MaintenanceStorageError>
  readonly readObject: (
    kind: MaintenanceObjectKind,
    id: string
  ) => Effect.Effect<Uint8Array, MaintenanceStorageError>
  readonly readWorking: (path: string) => Effect.Effect<Uint8Array | null, MaintenanceStorageError>
  readonly listPublished: Effect.Effect<
    ReadonlyArray<MaintenancePublishedEntry>,
    MaintenanceStorageError
  >
  readonly listIdempotency: Effect.Effect<
    ReadonlyArray<MaintenanceIdempotencyRecord>,
    MaintenanceStorageError
  >
  readonly listProtectedTransactions: Effect.Effect<
    ReadonlyArray<MaintenanceProtectedTransaction>,
    MaintenanceStorageError
  >
  readonly metadataStats: Effect.Effect<MaintenanceMetadataStats, MaintenanceStorageError>
  readonly removeObject: (
    kind: MaintenanceObjectKind,
    id: string
  ) => Effect.Effect<void, MaintenanceStorageError>
}

/** One issue found by an integrity pass. */
export interface IntegrityIssue {
  readonly code: string
  readonly target: string
  readonly detail: string
}

/** Canonical integrity summary. */
export interface IntegrityReport {
  readonly ok: boolean
  readonly headCommit: string | null
  readonly resources: number
  readonly objects: number
  readonly issues: ReadonlyArray<IntegrityIssue>
}

/** Canonical storage accounting summary. */
export interface StorageReport {
  readonly totalBytes: number
  readonly blobBytes: number
  readonly treeBytes: number
  readonly commitBytes: number
  readonly recoveryBytes: number
  readonly metadataBytes: number
  readonly resourceCount: number
  readonly commitCount: number
  readonly objectCount: number
}

/** Canonical collection summary. */
export interface CollectionReport {
  readonly scanned: number
  readonly removed: number
  readonly retained: number
  readonly bytesRemoved: number
}

/** Content-addressed roots retained by collection. */
export interface CollectionRoots {
  readonly commits: ReadonlySet<string>
  readonly trees: ReadonlySet<string>
  readonly blobs: ReadonlySet<string>
}

/** Optional clock/grace controls for collection. */
export interface CollectionOptions {
  readonly roots?: CollectionRoots
  readonly nowMillis?: number
  readonly gracePeriodMs?: number
  readonly cutoffMillis?: number
}

export type MaintenanceError = MaintenanceStorageError | InvalidRevisionInputError

const objectKinds: ReadonlyArray<MaintenanceObjectKind> = ["blob", "tree", "commit"]

const invalidInput = (message: string): Effect.Effect<never, InvalidRevisionInputError> =>
  Effect.fail(new InvalidRevisionInputError({ message }))

const validateTransaction = Effect.fn("maintenance.validateTransaction")(function* (
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

const objectIdFromFilenameUnsafe = (filename: string, jsonl: boolean): string => {
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
  kind: MaintenanceObjectKind,
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
    kind: MaintenanceObjectKind,
    entry: MaintenanceObjectEntry,
    issues: IntegrityIssue[]
  ): Effect.fn.Return<void, never> {
    const jsonl = kind !== "blob"
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
    if (kind === "blob") return
    const parse: Effect.Effect<TreeRecord | Commit, MaintenanceError> =
      kind === "tree" ? reader.tree(id) : reader.commit(id)
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

/** Validate all immutable objects, reachable history, indexes, and materialized files. */
export const integrityReport = Effect.fn("integrityReport")(function* (
  storage: MaintenanceStorage
): Effect.fn.Return<IntegrityReport, never> {
  const issues: IntegrityIssue[] = []
  const reader = makeReader(storage)
  const entries = new Map<MaintenanceObjectKind, ReadonlyArray<MaintenanceObjectEntry>>()
  let objectCount = 0
  for (const kind of objectKinds) {
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
      if (resource.state !== "active") continue
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

/** Account immutable objects and metadata bytes without reading object contents. */
export const storageReport = Effect.fn("storageReport")(function* (
  storage: MaintenanceStorage,
  resources: ReadonlyMap<string, ResourceVersion> | ReadonlyArray<ResourceVersion> | number = 0
): Effect.fn.Return<StorageReport, MaintenanceError> {
  const values: Record<MaintenanceObjectKind, ReadonlyArray<MaintenanceObjectEntry>> = {
    blob: yield* storage.listObjects("blob"),
    tree: yield* storage.listObjects("tree"),
    commit: yield* storage.listObjects("commit")
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
  const bytes = (kind: MaintenanceObjectKind): number =>
    values[kind].reduce((total, entry) => total + entry.byteSize, 0)
  const blobBytes = bytes("blob")
  const treeBytes = bytes("tree")
  const commitBytes = bytes("commit")
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
    objectCount: objectKinds.reduce((total, kind) => total + values[kind].length, 0)
  }
})

const collectionRoots = Effect.fn("collectionRoots")(function* (
  storage: MaintenanceStorage
): Effect.fn.Return<CollectionRoots, MaintenanceError> {
  const published = yield* storage.listPublished
  const publishedIds = new Set<string>()
  for (const marker of published) {
    if (!validHash(marker.commitId))
      return yield* corrupt(`published commit marker is invalid: ${marker.commitId}`)
    publishedIds.add(marker.commitId)
  }
  const current = yield* storage.readRef
  const commitRoots = new Set<string>()
  if (current !== null) {
    if (!validHash(current)) return yield* corrupt("current ref has an invalid commit identifier")
    if (!publishedIds.has(current))
      return yield* corrupt(`current ref points to unpublished commit: ${current}`)
    commitRoots.add(current)
  }

  const transactions = yield* storage.listProtectedTransactions
  for (const transaction of transactions) {
    yield* validateTransaction(transaction)
    commitRoots.add(transaction.newHead)
    if (transaction.oldHead !== null) commitRoots.add(transaction.oldHead)
  }
  const idempotency = yield* storage.listIdempotency
  for (const record of idempotency) {
    if (
      !validHash(record.keyHash) ||
      !validHash(record.requestHash) ||
      !validHash(record.commitId)
    ) {
      return yield* corrupt(`idempotency record ${record.keyHash} has invalid identifiers`)
    }
    commitRoots.add(record.commitId)
  }

  const reader = makeReader(storage)
  const commits = new Set<string>()
  const trees = new Set<string>()
  const blobs = new Set<string>()
  const pending = [...commitRoots]
  for (let commitId = pending.pop(); commitId !== undefined; commitId = pending.pop()) {
    if (commits.has(commitId)) continue
    const parsed = yield* reader.commit(commitId)
    commits.add(commitId)
    const closure = yield* reader.treeClosure(parsed.treeId)
    for (const treeId of closure) trees.add(treeId)
    const resources = yield* reader.transition(parsed)
    for (const resource of resources.values()) {
      yield* reader.verifyBlob(resource.blobId)
      blobs.add(resource.blobId)
    }
    if (parsed.parentId !== null) pending.push(parsed.parentId)
  }
  for (const transaction of transactions) {
    const closure = yield* reader.treeClosure(transaction.treeId)
    for (const treeId of closure) trees.add(treeId)
    for (const row of transaction.rows) {
      if (row.oldBlob !== null) blobs.add(row.oldBlob)
      if (row.newBlob !== null) blobs.add(row.newBlob)
    }
  }
  return { commits, trees, blobs }
})

const isCollectionRoots = (value: CollectionRoots | CollectionOptions): value is CollectionRoots =>
  "commits" in value && "trees" in value && "blobs" in value

const collectEffect = Effect.fn("collect")(function* (
  storage: MaintenanceStorage,
  input: CollectionRoots | CollectionOptions | undefined = undefined,
  explicitCutoffMillis?: number
): Effect.fn.Return<CollectionReport, MaintenanceError> {
  const roots =
    input !== undefined && isCollectionRoots(input)
      ? input
      : (input?.roots ?? (yield* collectionRoots(storage)))
  const options = input !== undefined && !isCollectionRoots(input) ? input : undefined
  const nowMillis =
    options?.nowMillis ??
    (explicitCutoffMillis !== undefined ? explicitCutoffMillis : yield* Clock.currentTimeMillis)
  const gracePeriodMs = options?.gracePeriodMs ?? 30 * 24 * 60 * 60 * 1000
  const cutoffMillis = explicitCutoffMillis ?? options?.cutoffMillis ?? nowMillis - gracePeriodMs
  if (!Number.isFinite(nowMillis) || !Number.isFinite(cutoffMillis)) {
    return yield* invalidInput("collection clock values must be finite")
  }
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    return yield* invalidInput("gracePeriodMs must not be negative")
  }

  let scanned = 0
  let removed = 0
  let retained = 0
  let bytesRemoved = 0
  const reachableByKind: Record<MaintenanceObjectKind, ReadonlySet<string>> = {
    blob: roots.blobs,
    tree: roots.trees,
    commit: roots.commits
  }
  for (const kind of objectKinds) {
    const entries = yield* storage.listObjects(kind)
    for (const entry of entries) {
      const id = objectIdFromFilenameUnsafe(entry.name, kind !== "blob")
      scanned += 1
      if (reachableByKind[kind].has(id) || entry.modifiedAtMillis > cutoffMillis) {
        retained += 1
        continue
      }
      const content = yield* storage.readObject(kind, id)
      if (sha256Hex(content) !== id)
        return yield* corrupt(`unreachable object is corrupt: ${entry.name}`)
      yield* storage.removeObject(kind, id)
      removed += 1
      bytesRemoved += entry.byteSize
    }
  }
  return { scanned, removed, retained, bytesRemoved }
})

/** Collect unreachable immutable objects after the configured grace period. */
export const collect = (
  storage: MaintenanceStorage,
  input?: CollectionRoots | CollectionOptions,
  cutoffMillis?: number
): Effect.Effect<CollectionReport, MaintenanceError> => collectEffect(storage, input, cutoffMillis)
