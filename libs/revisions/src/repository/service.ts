import { randomUUID } from "node:crypto"

import { parseIdempotencyRecord } from "../domain/transaction.js"
import { Context, Effect, Layer, Semaphore, type FileSystem, type Path, type Scope } from "effect"

import { parseCommitObject } from "../domain/codec.js"
import { ChangeSet, Restore, isActive, normalizeRelativePath } from "../domain/model.js"
import {
  CorruptRepositoryError,
  IdempotencyConflictError,
  InvalidRevisionInputError,
  RepositoryClosedError,
  RevisionConflictError
} from "../domain/errors.js"
import { encodeUtf8 } from "../domain/format.js"
import { adoptWorkingChange, commit, decodeChangeSet } from "./commit.js"
import { makeHistoryQuery } from "./history.js"
import {
  diff as queryDiff,
  diffPage as queryDiffPage,
  diffVersionsPage as queryDiffVersionsPage
} from "../domain/query.js"
import { maintenanceStorageFromRevisionStorage } from "../storage/maintenance-adapter.js"
import { collect as collectObjects } from "../storage/maintenance-collect.js"
import {
  integrityReport as inspectIntegrity,
  storageReport as inspectStorage
} from "../storage/maintenance.js"
import { revisionStorageLayer } from "../storage/service.js"
import { RevisionStorage } from "../storage/service-types.js"
import { type RevisionLockFactory } from "../storage/service-types.js"
import {
  currentMap,
  readCommit,
  type RevisionReadCache,
  type RevisionParsedCache,
  snapshotAt,
  validateTransition,
  validHash
} from "./state.js"
import { recoverTransactions, writeIdempotencyRecord } from "./transaction.js"
import { newWorkingScan, scanWorkingTree, adoptedChange } from "./working.js"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  type RepositoryError,
  type RepositoryOpenPhase,
  type ManagedFileRepositoryOptions,
  type ManagedFileRepositoryShape
} from "./service-types.js"

export class ManagedFileRepository extends Context.Service<
  ManagedFileRepository,
  ManagedFileRepositoryShape
>()("@arden-hq/revisions/ManagedFileRepository") {}

const defaultGcGracePeriodMs = 30 * 24 * 60 * 60 * 1_000

const makeRepository = Effect.fn("makeManagedFileRepository")(function* (
  options: ManagedFileRepositoryOptions
): Effect.fn.Return<ManagedFileRepositoryShape, RepositoryError, RevisionStorage | Scope.Scope> {
  const storage = yield* RevisionStorage
  const withLockQueue = (yield* Semaphore.make(1)).withPermit
  const scan = newWorkingScan()
  let closed = false
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true
    })
  )
  const reportOpen = (phase: RepositoryOpenPhase): void => {
    try {
      options.onOpenPhase?.(phase)
    } catch {}
  }
  reportOpen("revision_storage_ready")
  const gcGracePeriodMs = options.gcGracePeriodMs ?? defaultGcGracePeriodMs
  if (!Number.isSafeInteger(gcGracePeriodMs) || gcGracePeriodMs < 0) {
    return yield* new InvalidRevisionInputError({
      message: "gcGracePeriodMs must be a non-negative safe integer"
    })
  }
  const withRepositoryLock = Effect.fn("RevisionRepository.withRepositoryLock")(function* <A>(
    operation: Effect.Effect<A, RepositoryError>,
    onLockAcquired?: () => void
  ): Effect.fn.Return<A, RepositoryError> {
    return yield* storage.withLock(
      Effect.andThen(
        Effect.sync(() => onLockAcquired?.()),
        operation
      )
    )
  })
  const recoverUnderLock = withRepositoryLock(
    Effect.gen(function* () {
      yield* storage.initialize
      reportOpen("revision_initialized")
      yield* recoverTransactions(storage)
      reportOpen("revision_recovered")
      yield* storage.readRef
      reportOpen("revision_ref_checked")
    }),
    () => reportOpen("revision_lock_acquired")
  )
  const sweepAfterOpen = Effect.forkScoped(
    withLockQueue(withRepositoryLock(storage.cleanupMetadataTemps("."))).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Revision history temporary sweep failed", cause)
      )
    )
  )
  const openRepository = Effect.andThen(recoverUnderLock, sweepAfterOpen)
  yield* openRepository
  const loadCommit = (id: string) =>
    storage.readCommit(id).pipe(Effect.flatMap((bytes) => parseCommitObject(id, bytes)))
  const readPublishedHead = Effect.gen(function* () {
    const id = yield* storage.readRef
    if (id === null || (yield* storage.isPublished(id))) return id
    const pending = yield* loadCommit(id)
    if (pending.parentId === null || (yield* storage.isPublished(pending.parentId)))
      return pending.parentId
    return yield* new CorruptRepositoryError({
      message: `current ref points to unpublished commit: ${id}`
    })
  })
  const head = readPublishedHead.pipe(
    Effect.flatMap((id) =>
      id === null
        ? Effect.succeed(null)
        : Effect.gen(function* () {
            const commit = yield* loadCommit(id)
            yield* validateTransition(storage, commit)
            return id
          })
    )
  )
  const parsed: RevisionParsedCache = { trees: new Map(), commits: new Map() }
  const queryHistory = makeHistoryQuery()
  const currentSnapshot = readPublishedHead.pipe(Effect.flatMap((id) => snapshotAt(storage, id)))
  const maintenanceStorage = maintenanceStorageFromRevisionStorage(storage)

  const repository: ManagedFileRepositoryShape = {
    head,
    currentRevision: readPublishedHead,
    isReachable: Effect.fn("RevisionRepository.isReachable")(function* (commitId) {
      if (!validHash(commitId)) return false
      return yield* storage.isPublished(commitId)
    }),
    get: Effect.fn("RevisionRepository.get")(function* (resourceId, options = {}) {
      const resources = yield* options.at === undefined || options.at === null
        ? currentSnapshot
        : snapshotAt(storage, options.at)
      return resources.get(resourceId) ?? null
    }),
    findByPath: Effect.fn("RevisionRepository.findByPath")(function* (path, options = {}) {
      const normalized = yield* normalizeRelativePath(path)
      const resources = yield* options.at === undefined || options.at === null
        ? currentSnapshot
        : snapshotAt(storage, options.at)
      return (
        [...resources.values()].find(
          (resource) =>
            resource.path === normalized && (options.includeArchived === true || isActive(resource))
        ) ?? null
      )
    }),
    listResources: Effect.fn("RevisionRepository.listResources")(function* (options = {}) {
      const resources = yield* options.at === undefined || options.at === null
        ? currentSnapshot
        : snapshotAt(storage, options.at)
      return [...resources.values()]
        .filter((resource) => options.includeArchived === true || isActive(resource))
        .sort((left, right) => compareCodePoints(left.resourceId, right.resourceId))
    }),
    read: Effect.fn("RevisionRepository.read")(function* (resourceId, options = {}) {
      const resource = yield* repository.get(resourceId, options)
      if (resource === null)
        return yield* new RevisionConflictError({ message: `resource is not found: ${resourceId}` })
      return yield* storage.readBlob(resource.blobId)
    }),
    readVersion: (version) => storage.readBlob(version.blobId),
    contentSize: Effect.fn("RevisionRepository.contentSize")(function* (resource, options = {}) {
      if (typeof resource !== "string" && options.at !== undefined && options.at !== null) {
        return yield* new RevisionConflictError({
          message: "at is only supported when contentSize receives a resource ID"
        })
      }
      const version =
        typeof resource !== "string" ? resource : yield* repository.get(resource, options)
      if (version === null || version === undefined)
        return yield* new RevisionConflictError({
          message: `resource is not found: ${String(resource)}`
        })
      return yield* storage.blobSize(version.blobId)
    }),
    inspectCommit: Effect.fn("RevisionRepository.inspectCommit")(function* (commitId) {
      if (!validHash(commitId) || !(yield* storage.isPublished(commitId)))
        return yield* new RevisionConflictError({ message: `commit is not reachable: ${commitId}` })
      return yield* loadCommit(commitId)
    }),
    commit: (request) =>
      withLockQueue(
        decodeChangeSet(request).pipe(
          Effect.flatMap((changeSet) => commit(storage, head, changeSet, options.checkpoint))
        )
      ),
    idempotencyReceipt: Effect.fn("RevisionRepository.idempotencyReceipt")(
      function* (idempotencyKey) {
        if (idempotencyKey.length === 0) {
          return yield* new InvalidRevisionInputError({
            message: "idempotency key must be non-empty"
          })
        }
        const keyHash = sha256Hex(encodeUtf8(idempotencyKey))
        const content = yield* storage.readIdempotency(keyHash)
        if (content === null) return null
        const receipt = yield* parseIdempotencyRecord(content, keyHash)
        yield* storage
          .readCommit(receipt.commitId)
          .pipe(Effect.flatMap((bytes) => parseCommitObject(receipt.commitId, bytes)))
        return receipt
      }
    ),
    finalizeIdempotencyReceipt: (idempotencyKey, requestIdentity) =>
      withLockQueue(
        Effect.gen(function* () {
          if (idempotencyKey.length === 0 || requestIdentity.length === 0) {
            return yield* new InvalidRevisionInputError({
              message: "receipt identity must be non-empty"
            })
          }
          const critical = Effect.gen(function* () {
            yield* recoverTransactions(storage)
            const keyHash = sha256Hex(encodeUtf8(idempotencyKey))
            const requestHash = sha256Hex(encodeUtf8(requestIdentity))
            const existing = yield* storage.readIdempotency(keyHash)
            if (existing !== null) {
              const receipt = yield* parseIdempotencyRecord(existing, keyHash)
              if (receipt.requestHash !== requestHash) {
                return yield* new IdempotencyConflictError({
                  message: `idempotency key was reused for a different receipt: ${idempotencyKey}`
                })
              }
              return receipt
            }
            const commitId = yield* head
            if (commitId === null) {
              return yield* new InvalidRevisionInputError({
                message: "cannot finalize a receipt in an empty repository"
              })
            }
            yield* storage
              .readCommit(commitId)
              .pipe(Effect.flatMap((bytes) => parseCommitObject(commitId, bytes)))
            yield* writeIdempotencyRecord(storage, keyHash, requestHash, commitId)
            return { requestHash, commitId }
          })
          return yield* storage.withLock(critical)
        })
      ),
    workingTreeStatus: (statusOptions = {}) =>
      withLockQueue(
        withRepositoryLock(
          Effect.gen(function* () {
            yield* recoverTransactions(storage)
            const revision = yield* readPublishedHead
            const resources = yield* currentMap(storage, revision)
            return yield* scanWorkingTree(storage, scan, revision, resources, statusOptions)
          })
        )
      ),
    adoptWorkingChange: (change, input) =>
      withLockQueue(
        adoptWorkingChange(storage, head, adoptedChange(change), input, options.checkpoint)
      ),
    prepareHistory: Effect.fn("RevisionRepository.prepareHistory")(function* () {
      const cache: RevisionReadCache = { trees: new Map(), commits: new Map(), parsed }
      yield* queryHistory.prepare({
        head: yield* readPublishedHead,
        loadCommit: (id) => readCommit(storage, id, cache)
      })
    }),
    history: Effect.fn("RevisionRepository.history")(function* (input = {}) {
      const cache: RevisionReadCache = { trees: new Map(), commits: new Map(), parsed }
      const current = yield* readPublishedHead
      return yield* queryHistory.query({
        head: current,
        resourceId: input.resourceId ?? null,
        start: input.start ?? null,
        stopBefore: input.stopBefore ?? null,
        limit: input.limit ?? null,
        validHash,
        requireReachable: (id) =>
          repository
            .isReachable(id)
            .pipe(
              Effect.flatMap((reachable) =>
                reachable
                  ? Effect.succeed(undefined)
                  : new RevisionConflictError({ message: `commit is not reachable: ${id}` })
              )
            ),
        loadCommit: (id) => readCommit(storage, id, cache),
        validateCommitTransition: (item) => validateTransition(storage, item, cache)
      })
    }),
    diff: Effect.fn("RevisionRepository.diff")(function* (base, target, options = {}) {
      const cache: RevisionReadCache = { trees: new Map(), commits: new Map(), parsed }
      const before = yield* snapshotAt(storage, base, cache)
      const after = yield* snapshotAt(storage, target, cache)
      return yield* queryDiff(before, after, options.resourceIds, (blobId) =>
        storage.readBlob(blobId)
      )
    }),
    diffPage: Effect.fn("RevisionRepository.diffPage")(function* (
      base,
      target,
      resourceId,
      options = {}
    ) {
      const cache: RevisionReadCache = { trees: new Map(), commits: new Map(), parsed }
      const before = yield* snapshotAt(storage, base, cache)
      const after = yield* snapshotAt(storage, target, cache)
      return yield* queryDiffPage(
        before.get(resourceId) ?? null,
        after.get(resourceId) ?? null,
        resourceId,
        options.offset ?? 0,
        options.limit ?? 16_384,
        options.tail ?? false,
        (blobId) => storage.readBlob(blobId)
      )
    }),
    diffVersionsPage: (before, after, options = {}) =>
      queryDiffVersionsPage(
        before,
        after,
        options.offset ?? 0,
        options.limit ?? 16_384,
        options.tail ?? false,
        options.sourceByteLimit,
        (blobId) => storage.blobSize(blobId),
        (blobId) => storage.readBlob(blobId)
      ),
    restoreFromCommit: (resourceId, sourceCommit, input) =>
      withLockQueue(
        Effect.gen(function* () {
          const source = yield* repository.get(resourceId, { at: sourceCommit })
          if (source === null)
            return yield* new RevisionConflictError({
              message: `resource is not found at commit: ${resourceId}`
            })
          const content = yield* storage.readBlob(source.blobId)
          const base = {
            operations: [
              new Restore({
                resourceId,
                expectedVersion: input.expectedVersion,
                path: input.path ?? source.path,
                content
              })
            ],
            actor: input.actor,
            origin: input.origin,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey ?? randomUUID(),
            enforceExpectedHead: input.enforceExpectedHead ?? false
          }
          return yield* commit(
            storage,
            head,
            input.expectedHead === undefined
              ? new ChangeSet(base)
              : new ChangeSet({ ...base, expectedHead: input.expectedHead }),
            options.checkpoint
          )
        })
      ),
    integrityReport: withLockQueue(withRepositoryLock(inspectIntegrity(maintenanceStorage))),
    storageReport: withLockQueue(
      withRepositoryLock(
        Effect.gen(function* () {
          yield* storage.cleanupMetadataTemps(".")
          yield* recoverTransactions(storage)
          return yield* inspectStorage(maintenanceStorage, yield* currentSnapshot)
        })
      )
    ),
    collect: (input = {}) =>
      withLockQueue(
        withRepositoryLock(
          Effect.gen(function* () {
            yield* storage.cleanupMetadataTemps(".")
            yield* recoverTransactions(storage)
            const gracePeriodMs = input.gracePeriodMs ?? gcGracePeriodMs
            return yield* collectObjects(
              maintenanceStorage,
              input.nowMillis === undefined
                ? { gracePeriodMs }
                : { gracePeriodMs, nowMillis: input.nowMillis }
            )
          })
        )
      )
  }
  const open = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | RepositoryClosedError> =>
    Effect.suspend((): Effect.Effect<A, E | RepositoryClosedError> =>
      closed ? Effect.fail(new RepositoryClosedError({ message: "repository is closed" })) : effect
    )
  return {
    head: open(repository.head),
    currentRevision: open(repository.currentRevision),
    isReachable: (commitId) => open(repository.isReachable(commitId)),
    get: (resourceId, at) => open(repository.get(resourceId, at)),
    findByPath: (path, at) => open(repository.findByPath(path, at)),
    listResources: (at) => open(repository.listResources(at)),
    read: (resourceId, at) => open(repository.read(resourceId, at)),
    readVersion: (version) => open(repository.readVersion(version)),
    contentSize: (resource, at) => open(repository.contentSize(resource, at)),
    inspectCommit: (commitId) => open(repository.inspectCommit(commitId)),
    commit: (request) => open(repository.commit(request)),
    idempotencyReceipt: (idempotencyKey) => open(repository.idempotencyReceipt(idempotencyKey)),
    finalizeIdempotencyReceipt: (idempotencyKey, requestIdentity) =>
      open(repository.finalizeIdempotencyReceipt(idempotencyKey, requestIdentity)),
    workingTreeStatus: (options) => open(repository.workingTreeStatus(options)),
    adoptWorkingChange: (change, input) => open(repository.adoptWorkingChange(change, input)),
    history: (input) => open(repository.history(input)),
    prepareHistory: () => open(repository.prepareHistory()),
    diff: (base, target, input) => open(repository.diff(base, target, input)),
    diffPage: (base, target, resourceId, input) =>
      open(repository.diffPage(base, target, resourceId, input)),
    diffVersionsPage: (before, after, input) =>
      open(repository.diffVersionsPage(before, after, input)),
    restoreFromCommit: (resourceId, sourceCommit, input) =>
      open(repository.restoreFromCommit(resourceId, sourceCommit, input)),
    integrityReport: open(repository.integrityReport),
    storageReport: open(repository.storageReport),
    collect: (input) => open(repository.collect(input))
  }
})

export const managedFileRepositoryLayer = (
  options: ManagedFileRepositoryOptions
): Layer.Layer<
  ManagedFileRepository,
  RepositoryError,
  FileSystem.FileSystem | Path.Path | RevisionLockFactory
> =>
  Layer.effect(ManagedFileRepository, makeRepository(options)).pipe(
    Layer.provide(revisionStorageLayer(options))
  )
