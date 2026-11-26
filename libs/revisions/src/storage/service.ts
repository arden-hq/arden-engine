import { Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect"

import { RevisionConflictError, RevisionStorageError, UnsafePathError } from "../domain/errors.js"
import { OBJECT_KIND } from "../domain/format.js"
import {
  atomicWrite,
  ensureDirectory,
  entryIsSymlink,
  inspectRegular,
  isAlreadyExists,
  isDirectory,
  isRegularFile,
  listWorkingTree,
  relativeParts,
  removeTree,
  storageFailure,
  syncDirectory
} from "./files.js"
import { objectDirectory as objectDirectoryName } from "./objects.js"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"
import { makeStorageIo } from "./storage-io.js"
import {
  RevisionLockFactory,
  RevisionStorage,
  type RevisionStorageOptions,
  type RevisionStorageShape,
  type StorageError
} from "./service-types.js"
import {
  bytesEqual,
  defaultLockStaleAfterMs,
  encodeRef,
  metadataScanConcurrency,
  minimumLockStaleAfterMs
} from "./storage-refs.js"

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
  const {
    workingRoot,
    historyRoot,
    metadataPath,
    workingPath,
    ensureMetadata,
    readRegular,
    readMetadataAsync,
    writeMetadataAsync,
    readWorkingAsync,
    writeWorkingAsync,
    objectPath,
    objectDirectory,
    objectIdFromName,
    readObject,
    writeObject,
    initialize,
    refPath,
    readCurrent
  } = yield* makeStorageIo(options, fs, path)
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
    readBlob: (id) => readObject(OBJECT_KIND.blob, id),
    writeBlob: Effect.fn("RevisionStorage.writeBlob")(function* (content) {
      const id = sha256Hex(content)
      const file = yield* objectPath(OBJECT_KIND.blob, id)
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
    readTree: (id) => readObject(OBJECT_KIND.tree, id),
    writeTree: (content) => writeObject(OBJECT_KIND.tree, content),
    readCommit: (id) => readObject(OBJECT_KIND.commit, id),
    writeCommit: (content) => writeObject(OBJECT_KIND.commit, content),
    blobSize: Effect.fn("RevisionStorage.blobSize")(function* (id) {
      const file = yield* objectPath(OBJECT_KIND.blob, id)
      const info = yield* inspectRegular(fs, file, false, true)
      return Number(info.size)
    }),
    commitSize: Effect.fn("RevisionStorage.commitSize")(function* (id) {
      const file = yield* objectPath(OBJECT_KIND.commit, id)
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
              if (isDirectory(info)) yield* removeTree(fs, path, child)
              else if (isRegularFile(info))
                yield* fs
                  .remove(child)
                  .pipe(
                    Effect.mapError((cause) => storageFailure("remove metadata temporary", cause))
                  )
            } else if (isDirectory(info)) {
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
      if (!isDirectory(info))
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
        if (!isDirectory(sourceInfo))
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
    listWorkingFiles: listWorkingTree(fs, path, workingRoot, historyRoot).pipe(
      Effect.map((entries) =>
        [...entries].sort((left, right) => compareCodePoints(left.path, right.path))
      )
    ),
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

export const revisionStorageLayer = (
  options: RevisionStorageOptions
): Layer.Layer<
  RevisionStorage,
  StorageError,
  FileSystem.FileSystem | Path.Path | RevisionLockFactory
> => Layer.effect(RevisionStorage, makeStorage(options))
