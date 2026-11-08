import { isWithin } from "@arden-hq/std/paths"
import { Context, Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect"

import { RevisionConflictError, RevisionStorageError, UnsafePathError } from "../domain/errors.js"
import {
  atomicWrite,
  ensureDirectory,
  entryIsSymlink,
  inspectRegular,
  isAlreadyExists,
  relativeParts,
  removeTree,
  storageFailure,
  syncDirectory
} from "./files.js"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

/** Filesystem roots used by a repository. Both paths may be relative. */
export interface RevisionLockFactoryShape {
  readonly acquire: (
    lockPath: string,
    staleAfterMs: number
  ) => Effect.Effect<RevisionLock, RevisionStorageError | RevisionConflictError>
}

export interface RevisionStorageOptions {
  readonly workingRoot: string
  readonly historyRoot?: string
  /** Lock age after which a crashed process may be reclaimed. Defaults to 10 minutes. */
  readonly lockStaleAfterMs?: number
}

interface RevisionLock {
  readonly release: Effect.Effect<void, RevisionStorageError>
  readonly lost: Effect.Effect<never, RevisionStorageError>
}

/** Platform lock service. The core layer requires an implementation. */
export class RevisionLockFactory extends Context.Service<
  RevisionLockFactory,
  RevisionLockFactoryShape
>()("@arden-hq/revisions/RevisionLockFactory") {}

export type StorageError = RevisionStorageError | RevisionConflictError | UnsafePathError

type RevisionObjectKind = "blob" | "tree" | "commit"

const OBJECT_DIRECTORY: Record<RevisionObjectKind, string> = {
  blob: "objects/blobs",
  tree: "objects/trees",
  commit: "commits"
}

const jsonlStem = (name: string): string | null =>
  name.endsWith(".jsonl") ? name.slice(0, -6) : null

interface RevisionMetadataStat {
  readonly size: number
  readonly mtimeMillis: number | null
}

/**
 * Durable filesystem operations used by the repository.
 *
 * This interface depends only on Effect's `FileSystem` and `Path` services.
 * The Node implementation is deliberately kept in `./node.ts`, so the core
 * remains injectable in tests and can be given a desktop-specific adapter.
 */
export interface RevisionStorageShape {
  readonly workingRoot: string
  readonly historyRoot: string
  readonly initialize: Effect.Effect<void, StorageError>
  /**
   * Run `operation` holding the on-disk repository lock. Acquisition is
   * uninterruptible and the release is registered with it, so an interrupted
   * caller never leaves the lock held (a leaked lock keeps its heartbeat and
   * refuses every later open in the process). Losing the lock fails `operation`.
   */
  readonly withLock: <A, E>(operation: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageError>
  readonly readBlob: (blobId: string) => Effect.Effect<Uint8Array, StorageError>
  readonly writeBlob: (content: Uint8Array) => Effect.Effect<string, StorageError>
  readonly readTree: (treeId: string) => Effect.Effect<Uint8Array, StorageError>
  readonly writeTree: (content: Uint8Array) => Effect.Effect<string, StorageError>
  readonly readCommit: (commitId: string) => Effect.Effect<Uint8Array, StorageError>
  readonly writeCommit: (content: Uint8Array) => Effect.Effect<string, StorageError>
  readonly blobSize: (blobId: string) => Effect.Effect<number, StorageError>
  readonly commitSize: (commitId: string) => Effect.Effect<number, StorageError>
  readonly listObjectIds: (
    kind: RevisionObjectKind
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly removeObject: (
    kind: RevisionObjectKind,
    id: string,
    missingOk?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly listPublished: Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly removePublished: (
    commitId: string,
    missingOk?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly metadataStat: (
    relativePath: string
  ) => Effect.Effect<RevisionMetadataStat | null, StorageError>
  readonly removeMetadataFile: (
    relativePath: string,
    missingOk?: boolean
  ) => Effect.Effect<void, StorageError>
  /** Remove crash-orphaned atomic-write temporaries under one metadata
   *  directory (`"."` for the whole history root). A missing directory has none. */
  readonly cleanupMetadataTemps: (relativeDirectory: string) => Effect.Effect<void, StorageError>
  readonly readRef: Effect.Effect<string | null, StorageError>
  readonly compareAndSwapRef: (
    expected: string | null,
    replacement: string | null
  ) => Effect.Effect<void, StorageError>
  readonly compensateRef: (
    expected: string,
    replacement: string | null
  ) => Effect.Effect<void, StorageError>
  readonly readIdempotency: (keyHash: string) => Effect.Effect<Uint8Array | null, StorageError>
  readonly writeIdempotency: (
    keyHash: string,
    content: Uint8Array
  ) => Effect.Effect<void, StorageError>
  readonly isPublished: (commitId: string) => Effect.Effect<boolean, StorageError>
  readonly publish: (commitId: string) => Effect.Effect<void, StorageError>
  readonly listMetadata: (
    relativePath: string
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly metadataExists: (relativePath: string) => Effect.Effect<boolean, StorageError>
  readonly readMetadata: (
    relativePath: string,
    allowMissing?: boolean
  ) => Effect.Effect<Uint8Array | null, StorageError>
  readonly writeMetadata: (
    relativePath: string,
    content: Uint8Array,
    noReplace?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly ensureMetadataDirectory: (relativePath: string) => Effect.Effect<void, StorageError>
  readonly removeMetadataTree: (relativePath: string) => Effect.Effect<void, StorageError>
  readonly renameMetadataDirectory: (
    source: string,
    target: string
  ) => Effect.Effect<void, StorageError>
  readonly readWorking: (
    relativePath: string,
    allowMissing?: boolean,
    requireStandalone?: boolean
  ) => Effect.Effect<Uint8Array | null, StorageError>
  readonly writeWorking: (
    relativePath: string,
    content: Uint8Array,
    noReplace?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly removeWorking: (
    relativePath: string,
    missingOk?: boolean
  ) => Effect.Effect<void, StorageError>
  readonly moveWorkingToMetadata: (
    workingPath: string,
    metadataPath: string
  ) => Effect.Effect<void, StorageError>
  readonly syncMetadataDirectory: (relativePath: string) => Effect.Effect<void, StorageError>
}

export class RevisionStorage extends Context.Service<RevisionStorage, RevisionStorageShape>()(
  "@arden-hq/revisions/RevisionStorage"
) {}

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const defaultLockStaleAfterMs = 10 * 60 * 1000
const minimumLockStaleAfterMs = 5_000
const metadataScanConcurrency = 16

const encodeRef = (commitId: string): Uint8Array =>
  new TextEncoder().encode(`{"commit_id":"${commitId}","version":2}\n`)

const decodeRefId = Effect.fn("RevisionStorage.decodeRefId")(function* (
  content: Uint8Array
): Effect.fn.Return<string, StorageError> {
  const record: unknown = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)),
    catch: (cause) => storageFailure("decode current ref", cause)
  })
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return yield* new RevisionStorageError({ message: "decode current ref: invalid ref shape" })
  }
  const value = record as Record<string, unknown>
  if (value.version !== 2) {
    return yield* new RevisionStorageError({
      message: `decode current ref: unsupported format ${String(value.version)}`
    })
  }
  if (
    typeof value.commit_id !== "string" ||
    value.commit_id.length !== 64 ||
    [...value.commit_id].some((char) => !"0123456789abcdef".includes(char))
  ) {
    return yield* new RevisionStorageError({ message: "decode current ref: invalid ref shape" })
  }
  if (bytesEqual(content, encodeRef(value.commit_id)) === false) {
    return yield* new RevisionStorageError({
      message: "decode current ref: current ref is not canonical"
    })
  }
  return value.commit_id
})

const makeStorage = Effect.fn("makeRevisionStorage")(function* (
  options: RevisionStorageOptions
): Effect.fn.Return<
  RevisionStorageShape,
  StorageError,
  FileSystem.FileSystem | Path.Path | RevisionLockFactory
> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const lockFactory = yield* RevisionLockFactory
  const lockStaleAfterMs = options.lockStaleAfterMs ?? defaultLockStaleAfterMs
  if (!Number.isSafeInteger(lockStaleAfterMs) || lockStaleAfterMs < minimumLockStaleAfterMs) {
    return yield* new RevisionStorageError({
      message: `lockStaleAfterMs must be a finite safe integer >= ${minimumLockStaleAfterMs}`
    })
  }
  const workingCandidate = path.resolve(options.workingRoot)
  const historyCandidate =
    options.historyRoot === undefined
      ? path.join(workingCandidate, ".managed-history")
      : path.resolve(options.historyRoot)
  yield* fs
    .makeDirectory(workingCandidate, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => storageFailure("create working root", cause)))
  yield* fs
    .makeDirectory(historyCandidate, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => storageFailure("create history root", cause)))
  const workingRoot = yield* fs
    .realPath(workingCandidate)
    .pipe(Effect.mapError((cause) => storageFailure("resolve working root", cause)))
  const historyRoot = yield* fs
    .realPath(historyCandidate)
    .pipe(Effect.mapError((cause) => storageFailure("resolve history root", cause)))
  const workingInfo = yield* fs
    .stat(workingRoot)
    .pipe(Effect.mapError((cause) => storageFailure("stat working root", cause)))
  const historyInfo = yield* fs
    .stat(historyRoot)
    .pipe(Effect.mapError((cause) => storageFailure("stat history root", cause)))
  if (workingInfo.dev !== historyInfo.dev) {
    return yield* new UnsafePathError({
      message: "working and history roots must be on the same filesystem"
    })
  }
  const defaultHistoryRoot = path.join(workingRoot, ".managed-history")
  if (
    workingRoot === historyRoot ||
    isWithin(historyRoot, workingRoot) ||
    (isWithin(workingRoot, historyRoot) && historyRoot !== defaultHistoryRoot)
  ) {
    return yield* new UnsafePathError({
      message: "history root must be separate or the default .managed-history child"
    })
  }

  const metadataPath = (value: string, allowRoot = false) =>
    relativeParts(value, allowRoot).pipe(
      Effect.map((parts) => parts.reduce((current, part) => path.join(current, part), historyRoot))
    )
  const workingPath = Effect.fn("RevisionStorage.workingPath")(function* (value: string) {
    const parts = yield* relativeParts(value)
    const target = parts.reduce((current, part) => path.join(current, part), workingRoot)
    if (isWithin(historyRoot, target))
      return yield* new UnsafePathError({
        message: `managed path enters repository history: ${value}`
      })
    return target
  })
  const ensureMetadata = (value: string) =>
    relativeParts(value, true).pipe(
      Effect.flatMap((parts) => ensureDirectory(fs, path, historyRoot, parts))
    )
  const readRegular = (file: string, allowMissing: boolean, standalone: boolean) =>
    inspectRegular(fs, file, allowMissing, standalone).pipe(
      Effect.flatMap((info) =>
        info === null
          ? Effect.succeed(null)
          : fs.readFile(file).pipe(Effect.mapError((cause) => storageFailure("read file", cause)))
      )
    )
  const readMetadataAsync = Effect.fn("RevisionStorage.readMetadataAsync")(function* (
    value: string,
    allowMissing = false
  ) {
    const file = yield* metadataPath(value)
    const parts = yield* relativeParts(value)
    yield* ensureDirectory(fs, path, historyRoot, parts.slice(0, -1))
    return yield* readRegular(file, allowMissing, true)
  })
  const writeMetadataAsync = Effect.fn("RevisionStorage.writeMetadataAsync")(function* (
    value: string,
    content: Uint8Array,
    noReplace = false
  ) {
    const file = yield* metadataPath(value)
    const parts = yield* relativeParts(value)
    yield* ensureDirectory(fs, path, historyRoot, parts.slice(0, -1))
    yield* atomicWrite(fs, path, file, content, noReplace)
  })
  const readWorkingAsync = Effect.fn("RevisionStorage.readWorkingAsync")(function* (
    value: string,
    allowMissing = false,
    standalone = true
  ) {
    const file = yield* workingPath(value)
    const parts = yield* relativeParts(value)
    yield* ensureDirectory(fs, path, workingRoot, parts.slice(0, -1))
    return yield* readRegular(file, allowMissing, standalone)
  })
  const writeWorkingAsync = Effect.fn("RevisionStorage.writeWorkingAsync")(function* (
    value: string,
    content: Uint8Array,
    noReplace = false
  ) {
    const file = yield* workingPath(value)
    const parts = yield* relativeParts(value)
    yield* ensureDirectory(fs, path, workingRoot, parts.slice(0, -1))
    yield* atomicWrite(fs, path, file, content, noReplace)
  })
  const objectDirectoryName = (kind: RevisionObjectKind): string => OBJECT_DIRECTORY[kind]
  const objectPath = (kind: "blob" | "tree" | "commit", id: string) => {
    if (id.length !== 64 || [...id].some((char) => !"0123456789abcdef".includes(char))) {
      return Effect.fail(new UnsafePathError({ message: `${kind} identifier is invalid: ${id}` }))
    }
    return metadataPath(`${objectDirectoryName(kind)}/${kind === "blob" ? id : `${id}.jsonl`}`)
  }
  const objectDirectory = (kind: RevisionObjectKind) => metadataPath(objectDirectoryName(kind))
  const objectIdFromName = (kind: RevisionObjectKind, name: string): string | null => {
    const id = kind === "blob" ? name : jsonlStem(name)
    return id !== null &&
      id.length === 64 &&
      [...id].every((char) => "0123456789abcdef".includes(char))
      ? id
      : null
  }
  const readObject = Effect.fn("RevisionStorage.readObject")(function* (
    kind: "blob" | "tree" | "commit",
    id: string
  ) {
    const file = yield* objectPath(kind, id)
    const content = yield* readRegular(file, true, true)
    if (content === null)
      return yield* new RevisionStorageError({ message: `required ${kind} is missing: ${id}` })
    if (sha256Hex(content) !== id)
      return yield* new RevisionStorageError({ message: `${kind} hash mismatch: ${id}` })
    return content
  })
  const writeObject = Effect.fn("RevisionStorage.writeObject")(function* (
    kind: "tree" | "commit",
    content: Uint8Array
  ) {
    const id = sha256Hex(content)
    const file = yield* objectPath(kind, id)
    yield* ensureMetadata(objectDirectoryName(kind))
    yield* atomicWrite(fs, path, file, content, true).pipe(
      Effect.catchTag("RevisionConflictError", () =>
        readRegular(file, false, true).pipe(
          Effect.flatMap((existing) =>
            existing !== null && bytesEqual(existing, content)
              ? Effect.succeed(undefined)
              : Effect.fail(
                  new RevisionStorageError({ message: `immutable ${kind} differs: ${id}` })
                )
          )
        )
      )
    )
    return id
  })
  const initialize = Effect.gen(function* () {
    yield* ensureDirectory(fs, path, workingRoot, [])
    yield* ensureDirectory(fs, path, historyRoot, [])
    for (const directory of [
      "objects",
      "objects/blobs",
      "objects/trees",
      "commits",
      "published",
      "refs",
      "transactions",
      "conflicts",
      "idempotency"
    ]) {
      yield* ensureMetadata(directory)
    }
    const lockFile = path.join(historyRoot, "repository.lock")
    const lockContent = yield* readRegular(lockFile, true, true)
    if (lockContent === null) {
      yield* atomicWrite(fs, path, lockFile, new Uint8Array(), true).pipe(
        Effect.catchTag("RevisionConflictError", () => Effect.void)
      )
    }
    const installedLock = yield* readRegular(lockFile, false, true)
    if (installedLock === null || installedLock.length !== 0) {
      return yield* new RevisionStorageError({ message: "repository lock file is not empty" })
    }
  })
  const refPath = path.join(historyRoot, "refs", "current.jsonl")
  const readCurrent = Effect.gen(function* () {
    const content = yield* readMetadataAsync("refs/current.jsonl", true)
    return content === null ? null : yield* decodeRefId(content)
  })

  const storage = RevisionStorage.of({
    workingRoot,
    historyRoot,
    initialize,
    withLock: (operation) =>
      Effect.acquireUseRelease(
        initialize.pipe(
          Effect.andThen(
            lockFactory.acquire(path.join(historyRoot, "repository.lock"), lockStaleAfterMs)
          )
        ),
        (lock) => Effect.raceFirst(operation, lock.lost),
        (lock) => lock.release.pipe(Effect.orDie)
      ),
    readBlob: (id) => readObject("blob", id),
    writeBlob: Effect.fn("RevisionStorage.writeBlob")(function* (content) {
      const id = sha256Hex(content)
      const file = yield* objectPath("blob", id)
      yield* ensureMetadata("objects/blobs")
      yield* atomicWrite(fs, path, file, content, true).pipe(
        Effect.catchTag("RevisionConflictError", () =>
          readRegular(file, false, true).pipe(
            Effect.flatMap((existing) =>
              existing !== null && bytesEqual(existing, content)
                ? Effect.succeed(undefined)
                : Effect.fail(
                    new RevisionStorageError({ message: `immutable blob differs: ${id}` })
                  )
            )
          )
        )
      )
      return id
    }),
    readTree: (id) => readObject("tree", id),
    writeTree: (content) => writeObject("tree", content),
    readCommit: (id) => readObject("commit", id),
    writeCommit: (content) => writeObject("commit", content),
    blobSize: Effect.fn("RevisionStorage.blobSize")(function* (id) {
      const file = yield* objectPath("blob", id)
      const info = yield* inspectRegular(fs, file, false, true)
      return Number(info.size)
    }),
    commitSize: Effect.fn("RevisionStorage.commitSize")(function* (id) {
      const file = yield* objectPath("commit", id)
      const info = yield* inspectRegular(fs, file, false, true)
      return Number(info.size)
    }),
    listObjectIds: Effect.fn("RevisionStorage.listObjectIds")(function* (kind) {
      const directory = yield* objectDirectory(kind)
      yield* ensureMetadata(objectDirectoryName(kind))
      const names = yield* fs
        .readDirectory(directory)
        .pipe(Effect.mapError((cause) => storageFailure("list immutable objects", cause)))
      const ids: string[] = []
      for (const name of names) {
        const id = objectIdFromName(kind, name)
        if (id === null)
          return yield* new RevisionStorageError({
            message: `invalid ${kind} object name: ${name}`
          })
        const file = path.join(directory, name)
        yield* inspectRegular(fs, file, false, true)
        ids.push(id)
      }
      return ids.sort(compareCodePoints)
    }),
    removeObject: Effect.fn("RevisionStorage.removeObject")(function* (
      kind,
      id,
      missingOk = false
    ) {
      const file = yield* objectPath(kind, id)
      const info = yield* inspectRegular(fs, file, missingOk, true)
      if (info === null) return
      yield* fs
        .remove(file)
        .pipe(Effect.mapError((cause) => storageFailure("remove immutable object", cause)))
      yield* syncDirectory(fs, path.dirname(file))
    }),
    listPublished: Effect.gen(function* () {
      const directory = yield* metadataPath("published")
      const names = yield* fs
        .readDirectory(directory)
        .pipe(Effect.mapError((cause) => storageFailure("list publication markers", cause)))
      const ids: string[] = []
      for (const name of names) {
        if (name.length !== 64 || [...name].some((char) => !"0123456789abcdef".includes(char)))
          return yield* new RevisionStorageError({ message: `invalid publication marker: ${name}` })
        const marker = yield* readRegular(path.join(directory, name), false, true)
        if (marker === null || marker.length !== 0)
          return yield* new RevisionStorageError({
            message: `publication marker is not empty: ${name}`
          })
        ids.push(name)
      }
      return ids.sort(compareCodePoints)
    }),
    removePublished: Effect.fn("RevisionStorage.removePublished")(function* (
      id,
      missingOk = false
    ) {
      if (id.length !== 64 || [...id].some((char) => !"0123456789abcdef".includes(char)))
        return yield* new UnsafePathError({ message: `commit identifier is invalid: ${id}` })
      const file = yield* metadataPath(`published/${id}`)
      const marker = yield* readRegular(file, missingOk, true)
      if (marker === null) return
      if (marker.length !== 0)
        return yield* new RevisionStorageError({
          message: `publication marker is not empty: ${id}`
        })
      yield* fs
        .remove(file)
        .pipe(Effect.mapError((cause) => storageFailure("remove publication marker", cause)))
      yield* syncDirectory(fs, path.dirname(file))
    }),
    metadataStat: Effect.fn("RevisionStorage.metadataStat")(function* (value) {
      const file = yield* metadataPath(value)
      const linked = yield* entryIsSymlink(fs, file).pipe(
        Effect.mapError((cause) => storageFailure("inspect metadata", cause))
      )
      if (linked)
        return yield* new UnsafePathError({ message: `metadata entry is a symlink: ${value}` })
      const exists = yield* fs
        .exists(file)
        .pipe(Effect.mapError((cause) => storageFailure("check metadata", cause)))
      if (!exists) return null
      const info = yield* inspectRegular(fs, file, false, true)
      return {
        size: Number(info.size),
        mtimeMillis: Option.isSome(info.mtime) ? info.mtime.value.getTime() : null
      }
    }),
    removeMetadataFile: Effect.fn("RevisionStorage.removeMetadataFile")(function* (
      value,
      missingOk = false
    ) {
      const file = yield* metadataPath(value)
      const info = yield* inspectRegular(fs, file, missingOk, true)
      if (info === null) return
      yield* fs
        .remove(file)
        .pipe(Effect.mapError((cause) => storageFailure("remove metadata file", cause)))
      yield* syncDirectory(fs, path.dirname(file))
    }),
    cleanupMetadataTemps: Effect.fn("RevisionStorage.cleanupMetadataTemps")(function* (value) {
      const root = yield* metadataPath(value, true)
      const present = yield* fs
        .exists(root)
        .pipe(Effect.mapError((cause) => storageFailure("check metadata", cause)))
      if (!present) return
      const linked = yield* entryIsSymlink(fs, root).pipe(
        Effect.mapError((cause) => storageFailure("inspect metadata directory", cause))
      )
      if (linked)
        return yield* new UnsafePathError({ message: `metadata directory is a symlink: ${value}` })
      const probes = yield* Semaphore.make(metadataScanConcurrency)
      const visit = Effect.fn("RevisionStorage.visit")(function* (
        directory: string
      ): Effect.fn.Return<void, StorageError> {
        const names = yield* fs
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => storageFailure("list metadata", cause)))
        yield* Effect.forEach(
          names,
          Effect.fn("RevisionStorage.visitEntry")(function* (name) {
            const child = path.join(directory, name)
            const info = yield* probes.withPermit(
              Effect.gen(function* () {
                const linked = yield* entryIsSymlink(fs, child).pipe(
                  Effect.mapError((cause) => storageFailure("inspect metadata temporary", cause))
                )
                if (linked)
                  return yield* new UnsafePathError({
                    message: `metadata contains a symlink: ${child}`
                  })
                return yield* fs
                  .stat(child)
                  .pipe(
                    Effect.mapError((cause) => storageFailure("stat metadata temporary", cause))
                  )
              })
            )
            if (name.startsWith(".arden-")) {
              if (info.type === "Directory") yield* removeTree(fs, path, child)
              else if (info.type === "File")
                yield* fs
                  .remove(child)
                  .pipe(
                    Effect.mapError((cause) => storageFailure("remove metadata temporary", cause))
                  )
            } else if (info.type === "Directory") {
              yield* visit(child)
            }
          }),
          { concurrency: metadataScanConcurrency, discard: true }
        )
      })
      yield* visit(root)
    }),
    readRef: readCurrent,
    compareAndSwapRef: Effect.fn("RevisionStorage.compareAndSwapRef")(
      function* (expected, replacement) {
        yield* initialize
        const current = yield* readCurrent
        if (current !== expected)
          return yield* new RevisionConflictError({
            message: `current ref changed: expected ${expected ?? "null"}, found ${current ?? "null"}`
          })
        if (replacement === null) {
          yield* fs
            .remove(refPath, { force: true })
            .pipe(Effect.mapError((cause) => storageFailure("remove current ref", cause)))
          yield* syncDirectory(fs, path.dirname(refPath))
        } else {
          yield* atomicWrite(fs, path, refPath, encodeRef(replacement), false)
        }
      }
    ),
    compensateRef: Effect.fn("RevisionStorage.compensateRef")(function* (expected, replacement) {
      const current = yield* readCurrent
      if (current !== expected)
        return yield* new RevisionConflictError({
          message: `current ref changed during compensation: ${current ?? "null"}`
        })
      if (replacement === null)
        yield* fs
          .remove(refPath, { force: true })
          .pipe(Effect.mapError((cause) => storageFailure("remove current ref", cause)))
      else yield* atomicWrite(fs, path, refPath, encodeRef(replacement), false)
    }),
    readIdempotency: (keyHash) => readMetadataAsync(`idempotency/${keyHash}.jsonl`, true),
    writeIdempotency: (keyHash, content) =>
      writeMetadataAsync(`idempotency/${keyHash}.jsonl`, content, true),
    isPublished: (id) =>
      readMetadataAsync(`published/${id}`, true).pipe(
        Effect.flatMap((content) => {
          if (content === null) return Effect.succeed(false)
          return content.length === 0
            ? Effect.succeed(true)
            : Effect.fail(
                new RevisionStorageError({ message: `publication marker is not empty: ${id}` })
              )
        })
      ),
    publish: (id) => writeMetadataAsync(`published/${id}`, new Uint8Array(), true),
    listMetadata: Effect.fn("RevisionStorage.listMetadata")(function* (value) {
      const directory = yield* metadataPath(value, true)
      const linked = yield* entryIsSymlink(fs, directory).pipe(
        Effect.mapError((cause) => storageFailure("inspect metadata directory", cause))
      )
      if (linked)
        return yield* new UnsafePathError({ message: `metadata directory is a symlink: ${value}` })
      const info = yield* fs
        .stat(directory)
        .pipe(Effect.mapError((cause) => storageFailure("stat metadata directory", cause)))
      if (info.type !== "Directory")
        return yield* new UnsafePathError({ message: `metadata path is not a directory: ${value}` })
      return yield* fs
        .readDirectory(directory)
        .pipe(Effect.mapError((cause) => storageFailure("list metadata", cause)))
    }),
    metadataExists: Effect.fn("RevisionStorage.metadataExists")(function* (value) {
      const file = yield* metadataPath(value)
      const exists = yield* fs
        .exists(file)
        .pipe(Effect.mapError((cause) => storageFailure("check metadata", cause)))
      if (!exists) return false
      if (
        yield* entryIsSymlink(fs, file).pipe(
          Effect.mapError((cause) => storageFailure("inspect metadata", cause))
        )
      )
        return yield* new UnsafePathError({ message: `metadata entry is a symlink: ${value}` })
      return true
    }),
    readMetadata: (value, allowMissing = false) => readMetadataAsync(value, allowMissing),
    writeMetadata: (value, content, noReplace = false) =>
      writeMetadataAsync(value, content, noReplace),
    ensureMetadataDirectory: ensureMetadata,
    removeMetadataTree: (value) =>
      metadataPath(value).pipe(Effect.flatMap((directory) => removeTree(fs, path, directory))),
    renameMetadataDirectory: Effect.fn("RevisionStorage.renameMetadataDirectory")(
      function* (source, target) {
        const sourcePath = yield* metadataPath(source)
        const targetPath = yield* metadataPath(target)
        const sourceLink = yield* entryIsSymlink(fs, sourcePath).pipe(
          Effect.mapError((cause) => storageFailure("inspect metadata source", cause))
        )
        if (sourceLink)
          return yield* new UnsafePathError({ message: `metadata source is a symlink: ${source}` })
        const sourceInfo = yield* fs
          .stat(sourcePath)
          .pipe(Effect.mapError((cause) => storageFailure("stat metadata source", cause)))
        if (sourceInfo.type !== "Directory")
          return yield* new UnsafePathError({
            message: `metadata source is not a directory: ${source}`
          })
        if (
          yield* fs
            .exists(targetPath)
            .pipe(Effect.mapError((cause) => storageFailure("check metadata target", cause)))
        )
          return yield* new RevisionConflictError({
            message: `metadata target already exists: ${target}`
          })
        yield* fs.rename(sourcePath, targetPath).pipe(
          Effect.mapError((cause) =>
            isAlreadyExists(cause)
              ? new RevisionConflictError({
                  message: `metadata target already exists: ${target}`
                })
              : storageFailure("rename metadata directory", cause)
          )
        )
        yield* syncDirectory(fs, path.dirname(sourcePath))
        if (path.dirname(sourcePath) !== path.dirname(targetPath))
          yield* syncDirectory(fs, path.dirname(targetPath))
      }
    ),
    readWorking: (value, allowMissing = false, standalone = true) =>
      readWorkingAsync(value, allowMissing, standalone),
    writeWorking: (value, content, noReplace = false) =>
      writeWorkingAsync(value, content, noReplace),
    removeWorking: Effect.fn("RevisionStorage.removeWorking")(function* (value, missingOk = false) {
      const file = yield* workingPath(value)
      const info = yield* inspectRegular(fs, file, missingOk, true)
      if (info === null) return
      yield* fs
        .remove(file)
        .pipe(Effect.mapError((cause) => storageFailure("remove working file", cause)))
      yield* syncDirectory(fs, path.dirname(file))
    }),
    moveWorkingToMetadata: Effect.fn("RevisionStorage.moveWorkingToMetadata")(
      function* (working, metadata) {
        const workingParts = yield* relativeParts(working)
        const metadataParts = yield* relativeParts(metadata)
        yield* ensureDirectory(fs, path, workingRoot, workingParts.slice(0, -1))
        yield* ensureDirectory(fs, path, historyRoot, metadataParts.slice(0, -1))
        yield* moveNoReplace(workingPath(working), metadataPath(metadata), "displace working file")
      }
    ),
    syncMetadataDirectory: (value) =>
      metadataPath(value, true).pipe(Effect.flatMap((directory) => syncDirectory(fs, directory)))
  })
  const moveNoReplace = Effect.fn("RevisionStorage.moveNoReplace")(function* (
    sourceEffect: Effect.Effect<string, UnsafePathError>,
    targetEffect: Effect.Effect<string, UnsafePathError>,
    operation: string
  ): Effect.fn.Return<void, StorageError> {
    const source = yield* sourceEffect
    const target = yield* targetEffect
    const sourceInfo = yield* inspectRegular(fs, source, false, true)
    const targetDirectory = path.dirname(target)
    const targetDirectoryInfo = yield* fs
      .stat(targetDirectory)
      .pipe(Effect.mapError((cause) => storageFailure(`stat ${operation} target directory`, cause)))
    if (sourceInfo.dev !== targetDirectoryInfo.dev) {
      return yield* new RevisionStorageError({
        message: `${operation} requires source and target to be on the same filesystem`
      })
    }
    // A hard-link create is the no-replace primitive. A check followed by
    // rename would overwrite a target that appears between the two calls.
    yield* fs.link(source, target).pipe(
      Effect.mapError((cause) =>
        isAlreadyExists(cause)
          ? new RevisionConflictError({
              message: `${operation} target already exists: ${target}`
            })
          : storageFailure(operation, cause)
      )
    )
    yield* fs
      .remove(source)
      .pipe(Effect.mapError((cause) => storageFailure(`remove ${operation} source`, cause)))
    yield* syncDirectory(fs, path.dirname(source))
    yield* syncDirectory(fs, path.dirname(target))
  })
  return storage
})

/** Core layer: requires Effect `FileSystem`, `Path`, and an explicit lock factory; it has no Node imports. */
export const revisionStorageLayer = (
  options: RevisionStorageOptions
): Layer.Layer<
  RevisionStorage,
  StorageError,
  FileSystem.FileSystem | Path.Path | RevisionLockFactory
> => Layer.effect(RevisionStorage, makeStorage(options))
