import { Effect, FileSystem, Option, Path, Result } from "effect"
import { PlatformError, type SystemErrorTag } from "effect/PlatformError"

import { PATH_SEGMENT, normalizeRelativePath } from "../domain/model.js"
import { RevisionConflictError, RevisionStorageError, UnsafePathError } from "../domain/errors.js"
import type { StorageError } from "./service-types.js"
import { errorMessage } from "@arden-hq/std/errors"

interface WorkingStamp {
  readonly id: string
  readonly modifiedAt: number
}

export const WORKING_ENTRY_KIND = { file: "file", unreadable: "unreadable" } as const

export type WorkingEntry =
  | {
      readonly kind: typeof WORKING_ENTRY_KIND.file
      readonly path: string
      readonly stamp: WorkingStamp | undefined
    }
  | {
      readonly kind: typeof WORKING_ENTRY_KIND.unreadable
      readonly path: string
      readonly reason: string
    }

const FILE_TYPE = { file: "File", directory: "Directory" } as const
type EntryType = (typeof FILE_TYPE)[keyof typeof FILE_TYPE]
const hasType =
  (type: EntryType) =>
  (info: FileSystem.File.Info): boolean =>
    info.type === type
export const isDirectory = hasType(FILE_TYPE.directory)
export const isRegularFile = hasType(FILE_TYPE.file)

const NOT_A_LINK_CODE = "EINVAL"

export const storageFailure = (operation: string, cause: unknown): RevisionStorageError =>
  new RevisionStorageError({
    message: `${operation}: ${errorMessage(cause)}`,
    cause
  })

const isPlatform = (cause: unknown): cause is PlatformError => cause instanceof PlatformError

const isPlatformReason = (cause: unknown, reason: SystemErrorTag): boolean =>
  isPlatform(cause) && cause.reason._tag === reason

const isMissing = (cause: unknown): boolean => isPlatformReason(cause, "NotFound")
export const isAlreadyExists = (cause: unknown): boolean => isPlatformReason(cause, "AlreadyExists")
const isNotSymlink = (cause: unknown): boolean => {
  if (isMissing(cause)) return true
  if (
    !isPlatform(cause) ||
    !isPlatformReason(cause, "Unknown") ||
    typeof cause.reason.cause !== "object" ||
    cause.reason.cause === null
  )
    return false
  return "code" in cause.reason.cause && cause.reason.cause.code === NOT_A_LINK_CODE
}

export const relativeParts = Effect.fn("RevisionStorage.relativeParts")(function* (
  value: string,
  allowRoot = false
): Effect.fn.Return<ReadonlyArray<string>, UnsafePathError> {
  if (allowRoot && value === PATH_SEGMENT.current) return []
  const normalized = yield* normalizeRelativePath(value)
  return normalized.split("/")
})

export const entryIsSymlink = (
  fs: FileSystem.FileSystem,
  file: string
): Effect.Effect<boolean, PlatformError> =>
  fs.readLink(file).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", (error) =>
      isNotSymlink(error) ? Effect.succeed(false) : Effect.fail(error)
    )
  )

export const ensureDirectory = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  parts: ReadonlyArray<string>
): Effect.Effect<void, StorageError> =>
  walkDirectories(fs, path, root, parts, MISSING_DIRECTORY.create).pipe(Effect.asVoid)

export const directoriesPresent = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  parts: ReadonlyArray<string>
): Effect.Effect<boolean, StorageError> =>
  walkDirectories(fs, path, root, parts, MISSING_DIRECTORY.check)

const MISSING_DIRECTORY = { create: "create", check: "check" } as const

const walkDirectories = Effect.fn("RevisionStorage.walkDirectories")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  parts: ReadonlyArray<string>,
  missing: (typeof MISSING_DIRECTORY)[keyof typeof MISSING_DIRECTORY]
): Effect.fn.Return<boolean, StorageError> {
  const rootInfo = yield* fs
    .stat(root)
    .pipe(Effect.mapError((cause) => storageFailure("stat repository root", cause)))
  const rootLink = yield* entryIsSymlink(fs, root).pipe(
    Effect.mapError((cause) => storageFailure("inspect repository root", cause))
  )
  if (!isDirectory(rootInfo) || rootLink) {
    return yield* new UnsafePathError({ message: `repository root is not a directory: ${root}` })
  }
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const exists = yield* fs
      .exists(current)
      .pipe(Effect.mapError((cause) => storageFailure("check repository directory", cause)))
    if (!exists && missing === MISSING_DIRECTORY.check) return false
    if (!exists) {
      yield* fs
        .makeDirectory(current, { mode: 0o700 })
        .pipe(
          Effect.catchTag("PlatformError", (cause) =>
            isAlreadyExists(cause)
              ? Effect.succeed(undefined)
              : Effect.fail(storageFailure("create repository directory", cause))
          )
        )
    }
    const info = yield* fs
      .stat(current)
      .pipe(Effect.mapError((cause) => storageFailure("stat repository directory", cause)))
    const linked = yield* entryIsSymlink(fs, current).pipe(
      Effect.mapError((cause) => storageFailure("inspect repository directory", cause))
    )
    if (!isDirectory(info) || linked) {
      return yield* new UnsafePathError({
        message: `repository path is not a directory: ${current}`
      })
    }
  }
  return true
})

export function inspectRegular(
  fs: FileSystem.FileSystem,
  file: string,
  allowMissing: false,
  requireStandalone: boolean
): Effect.Effect<FileSystem.File.Info, StorageError>
export function inspectRegular(
  fs: FileSystem.FileSystem,
  file: string,
  allowMissing: boolean,
  requireStandalone: boolean
): Effect.Effect<FileSystem.File.Info | null, StorageError>
export function inspectRegular(
  fs: FileSystem.FileSystem,
  file: string,
  allowMissing: boolean,
  requireStandalone: boolean
): Effect.Effect<FileSystem.File.Info | null, StorageError> {
  return inspectRegularEntry(fs, file, allowMissing, requireStandalone)
}

const inspectRegularEntry = Effect.fn("RevisionStorage.inspectRegular")(function* (
  fs: FileSystem.FileSystem,
  file: string,
  allowMissing: boolean,
  requireStandalone: boolean
): Effect.fn.Return<FileSystem.File.Info | null, StorageError> {
  const linked = yield* entryIsSymlink(fs, file).pipe(
    Effect.mapError((cause) => storageFailure("inspect file", cause))
  )
  if (linked) return yield* new UnsafePathError({ message: `file is a symlink: ${file}` })
  const info = yield* fs.stat(file).pipe(
    Effect.catchTag("PlatformError", (cause) => {
      if (isMissing(cause))
        return allowMissing
          ? Effect.succeed(null)
          : Effect.fail(new RevisionStorageError({ message: `file is missing: ${file}` }))
      return Effect.fail(storageFailure("stat file", cause))
    })
  )
  if (info === null) return null
  if (!isRegularFile(info))
    return yield* new UnsafePathError({ message: `path is not a regular file: ${file}` })
  if (requireStandalone && Option.getOrElse(info.nlink, () => 1) !== 1) {
    return yield* new UnsafePathError({ message: `file has unsupported hard links: ${file}` })
  }
  return info
})

export const syncDirectory = (
  fs: FileSystem.FileSystem,
  directory: string
): Effect.Effect<void, RevisionStorageError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs
        .open(directory, { flag: "r" })
        .pipe(Effect.mapError((cause) => storageFailure("open directory for sync", cause)))
      yield* handle.sync.pipe(Effect.mapError((cause) => storageFailure("sync directory", cause)))
    })
  )

export const removeTree = Effect.fn("RevisionStorage.removeTree")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
): Effect.fn.Return<void, StorageError> {
  const exists = yield* fs
    .exists(directory)
    .pipe(Effect.mapError((cause) => storageFailure("check directory", cause)))
  if (!exists) return
  const linked = yield* entryIsSymlink(fs, directory).pipe(
    Effect.mapError((cause) => storageFailure("inspect directory", cause))
  )
  if (linked) return yield* new UnsafePathError({ message: `directory is a symlink: ${directory}` })
  const info = yield* fs
    .stat(directory)
    .pipe(Effect.mapError((cause) => storageFailure("stat directory", cause)))
  if (!isDirectory(info))
    return yield* new UnsafePathError({ message: `path is not a directory: ${directory}` })
  const children = yield* fs
    .readDirectory(directory)
    .pipe(Effect.mapError((cause) => storageFailure("list directory", cause)))
  for (const child of children) {
    const childPath = path.join(directory, child)
    const childLink = yield* entryIsSymlink(fs, childPath).pipe(
      Effect.mapError((cause) => storageFailure("inspect directory entry", cause))
    )
    if (childLink)
      return yield* new UnsafePathError({ message: `directory contains a symlink: ${childPath}` })
    const childInfo = yield* fs
      .stat(childPath)
      .pipe(Effect.mapError((cause) => storageFailure("stat directory entry", cause)))
    if (isDirectory(childInfo)) yield* removeTree(fs, path, childPath)
    else if (isRegularFile(childInfo))
      yield* fs
        .remove(childPath)
        .pipe(Effect.mapError((cause) => storageFailure("remove file", cause)))
    else
      return yield* new UnsafePathError({
        message: `directory contains unsupported entry: ${childPath}`
      })
  }
  yield* fs
    .remove(directory, { recursive: true })
    .pipe(Effect.mapError((cause) => storageFailure("remove directory", cause)))
})

const ATOMIC_TEMPORARY_PREFIX = ".arden-"

export const atomicWrite = Effect.fn("RevisionStorage.atomicWrite")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  content: Uint8Array,
  noReplace: boolean,
  mode = 0o600
): Effect.fn.Return<void, StorageError> {
  const parent = path.dirname(target)
  const existing = yield* inspectRegular(fs, target, true, true)
  if (existing !== null && noReplace)
    return yield* new RevisionConflictError({ message: `target already exists: ${target}` })
  const temporary = yield* fs
    .makeTempFile({ directory: parent, prefix: ATOMIC_TEMPORARY_PREFIX, suffix: ".tmp" })
    .pipe(Effect.mapError((cause) => storageFailure("create atomic temporary file", cause)))
  const temporaryDirectory = path.dirname(temporary)
  let installed = false
  try {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs
          .open(temporary, { flag: "w", mode })
          .pipe(Effect.mapError((cause) => storageFailure("open atomic temporary file", cause)))
        if (content.length > 0) {
          yield* handle
            .writeAll(content)
            .pipe(Effect.mapError((cause) => storageFailure("write atomic temporary file", cause)))
        }
        yield* handle.sync.pipe(
          Effect.mapError((cause) => storageFailure("sync atomic temporary file", cause))
        )
      })
    )
    if (noReplace) {
      yield* fs
        .link(temporary, target)
        .pipe(
          Effect.mapError((cause) =>
            isAlreadyExists(cause)
              ? new RevisionConflictError({ message: `target already exists: ${target}` })
              : storageFailure("install immutable file", cause)
          )
        )
      yield* fs
        .remove(temporary)
        .pipe(Effect.mapError((cause) => storageFailure("remove atomic temporary file", cause)))
    } else {
      yield* fs
        .rename(temporary, target)
        .pipe(Effect.mapError((cause) => storageFailure("replace file", cause)))
    }
    installed = true
    yield* syncDirectory(fs, parent)
  } finally {
    if (!installed) yield* fs.remove(temporary, { force: true }).pipe(Effect.ignore)
    yield* fs.remove(temporaryDirectory, { recursive: true, force: true }).pipe(Effect.ignore)
  }
})

const listWorkingEntry = Effect.fn("RevisionStorage.listWorkingEntry")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  historyRoot: string,
  entry: string,
  relative: string
): Effect.fn.Return<ReadonlyArray<WorkingEntry>, StorageError> {
  const linked = yield* entryIsSymlink(fs, entry).pipe(
    Effect.mapError((cause) => storageFailure("inspect working entry", cause))
  )
  if (linked) return [{ kind: WORKING_ENTRY_KIND.file, path: relative, stamp: undefined }]
  const info = yield* fs
    .stat(entry)
    .pipe(Effect.mapError((cause) => storageFailure("stat working entry", cause)))
  if (isRegularFile(info)) {
    const modifiedAt = Option.match(info.mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime()
    })
    return [
      {
        kind: WORKING_ENTRY_KIND.file,
        path: relative,
        stamp: {
          id: [info.dev, Option.getOrElse(info.ino, () => 0), info.size, modifiedAt].join(":"),
          modifiedAt
        }
      }
    ]
  }
  if (!isDirectory(info))
    return [{ kind: WORKING_ENTRY_KIND.file, path: relative, stamp: undefined }]
  return yield* listWorkingFolder(fs, path, historyRoot, entry, `${relative}/`)
})

const listWorkingFolder = Effect.fn("RevisionStorage.listWorkingFolder")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  historyRoot: string,
  directory: string,
  prefix: string
): Effect.fn.Return<ReadonlyArray<WorkingEntry>, StorageError> {
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.mapError((cause) => storageFailure("list working folder", cause)))
  const entries: Array<WorkingEntry> = []
  for (const name of names) {
    const entry = path.join(directory, name)
    if (entry === historyRoot || name.startsWith(ATOMIC_TEMPORARY_PREFIX)) continue
    const relative = `${prefix}${name}`
    const listed = yield* Effect.result(listWorkingEntry(fs, path, historyRoot, entry, relative))
    if (Result.isSuccess(listed)) entries.push(...listed.success)
    else if (!(listed.failure instanceof RevisionStorageError && isMissing(listed.failure.cause)))
      entries.push({
        kind: WORKING_ENTRY_KIND.unreadable,
        path: relative,
        reason: listed.failure.message
      })
  }
  return entries
})

export const listWorkingTree = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workingRoot: string,
  historyRoot: string
): Effect.Effect<ReadonlyArray<WorkingEntry>, StorageError> =>
  listWorkingFolder(fs, path, historyRoot, workingRoot, "")
