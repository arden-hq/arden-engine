import { isWithin } from "@arden-hq/std/paths"
import { Effect, FileSystem, Path } from "effect"

import { RevisionStorageError, UnsafePathError } from "../domain/errors.js"
import { OBJECT_KIND, type ObjectKind } from "../domain/format.js"
import {
  atomicWrite,
  directoriesPresent,
  ensureDirectory,
  inspectRegular,
  relativeParts,
  storageFailure
} from "./files.js"
import { isJsonlObject, objectDirectory as objectDirectoryName, objectLocation } from "./objects.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { jsonlStem, type RevisionStorageOptions } from "./service-types.js"
import { bytesEqual, decodeRefId } from "./storage-refs.js"

export const makeStorageIo = Effect.fn("makeRevisionStorageIo")(function* (
  options: RevisionStorageOptions,
  fs: FileSystem.FileSystem,
  path: Path.Path
) {
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
    if (!(yield* directoriesPresent(fs, path, workingRoot, parts.slice(0, -1)))) {
      return allowMissing
        ? null
        : yield* new RevisionStorageError({ message: `file is missing: ${file}` })
    }
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
  const objectPath = (kind: ObjectKind, id: string) => {
    if (id.length !== 64 || [...id].some((char) => !"0123456789abcdef".includes(char))) {
      return Effect.fail(new UnsafePathError({ message: `${kind} identifier is invalid: ${id}` }))
    }
    return metadataPath(objectLocation(kind, id))
  }
  const objectDirectory = (kind: ObjectKind) => metadataPath(objectDirectoryName(kind))
  const objectIdFromName = (kind: ObjectKind, name: string): string | null => {
    const id = isJsonlObject(kind) ? jsonlStem(name) : name
    return id !== null &&
      id.length === 64 &&
      [...id].every((char) => "0123456789abcdef".includes(char))
      ? id
      : null
  }
  const readObject = Effect.fn("RevisionStorage.readObject")(function* (
    kind: ObjectKind,
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
    kind: typeof OBJECT_KIND.tree | typeof OBJECT_KIND.commit,
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
  return {
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
  }
})
