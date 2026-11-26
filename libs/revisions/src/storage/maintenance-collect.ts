import { Clock, Effect } from "effect"

import { OBJECT_KINDS, type ObjectKind } from "../domain/format.js"
import { isJsonlObject } from "./objects.js"
import { corrupt, makeReader, validHash } from "./maintenance-reader.js"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  type CollectionOptions,
  type CollectionReport,
  type CollectionRoots,
  type MaintenanceError,
  type MaintenanceStorage
} from "./maintenance-types.js"
import { invalidInput, validateTransaction, objectIdFromFilenameUnsafe } from "./maintenance.js"

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
  const reachableByKind: Record<ObjectKind, ReadonlySet<string>> = {
    blob: roots.blobs,
    tree: roots.trees,
    commit: roots.commits
  }
  for (const kind of OBJECT_KINDS) {
    const entries = yield* storage.listObjects(kind)
    for (const entry of entries) {
      const id = objectIdFromFilenameUnsafe(entry.name, isJsonlObject(kind))
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

export const collect = (
  storage: MaintenanceStorage,
  input?: CollectionRoots | CollectionOptions,
  cutoffMillis?: number
): Effect.Effect<CollectionReport, MaintenanceError> => collectEffect(storage, input, cutoffMillis)
