import { Effect } from "effect"
import { lstat, readdir } from "node:fs/promises"
import type { Stats } from "node:fs"
import { join, relative } from "node:path"
import { StorageError, storageError, type StorageOperation } from "./errors.js"
import { classifyStorageRootEntry, type StorageRootBucket } from "./catalog.js"
import { isErrnoCode } from "../fs/private-store.js"
import { sha256Hex } from "@arden-hq/std/hash"

const MAX_INVENTORY_ENTRIES = 100_000

export interface CategoryTally {
  totalBytes: number
  itemCount: number
}

interface StorageUnitMember {
  readonly name: string
  readonly path: string
  readonly kind: "file" | "directory"
  readonly sizeBytes: number
  readonly modifiedMilliseconds: number
  readonly fingerprint: string
}

export interface StorageUnit {
  readonly id: string
  readonly name: string
  readonly members: ReadonlyArray<StorageUnitMember>
  readonly sizeBytes: number
  readonly modifiedMilliseconds: number
}

export const filesystem = <A>(
  operation: StorageOperation,
  message: string,
  run: () => Promise<A>
): Effect.Effect<A, StorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => storageError(operation, "storage", message, cause)
  })

export const addSafe = (current: number, next: number): number => {
  const total = current + next
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Storage size exceeds the supported range")
  }
  return total
}

const requireFileSize = (status: Stats): number => {
  if (!Number.isSafeInteger(status.size) || status.size < 0) {
    throw new Error("Storage file size is invalid")
  }
  return status.size
}

const unitKind = (status: Stats): StorageUnitMember["kind"] | null => {
  if (status.isFile()) return "file"
  if (status.isDirectory()) return "directory"
  return null
}

const fingerprintType = (status: Stats): string => {
  if (status.isFile()) return "file"
  if (status.isDirectory()) return "directory"
  if (status.isSymbolicLink()) return "symlink"
  return "other"
}

export type RootBucket = StorageRootBucket

const emptyTallies = (): Record<RootBucket, CategoryTally> => ({
  database: { totalBytes: 0, itemCount: 0 },
  chats: { totalBytes: 0, itemCount: 0 },
  agents: { totalBytes: 0, itemCount: 0 },
  knowledge: { totalBytes: 0, itemCount: 0 },
  skills: { totalBytes: 0, itemCount: 0 },
  housekeeping: { totalBytes: 0, itemCount: 0 },
  other: { totalBytes: 0, itemCount: 0 }
})

export const scanInventoryUnsafe = async (
  root: string,
  databaseName: string | null
): Promise<Record<RootBucket, CategoryTally>> => {
  const rootStatus = await lstat(root)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("Arden storage root is not a directory")
  }

  const tallies = emptyTallies()
  const directories: Array<{ readonly path: string; readonly category: RootBucket }> = []
  const rootEntries = await readdir(root, { withFileTypes: true })
  let visited = 0

  for (const entry of rootEntries) {
    directories.push({
      path: join(root, entry.name),
      category: classifyStorageRootEntry(entry.name, databaseName).bucket
    })
  }

  for (let next = directories.pop(); next !== undefined; next = directories.pop()) {
    visited += 1
    if (visited > MAX_INVENTORY_ENTRIES) {
      throw new Error("Arden storage inventory is too large")
    }
    const status = await lstat(next.path)
    if (status.isSymbolicLink()) continue
    if (status.isFile()) {
      const tally = tallies[next.category]
      tally.totalBytes = addSafe(tally.totalBytes, requireFileSize(status))
      tally.itemCount = addSafe(tally.itemCount, 1)
      continue
    }
    if (!status.isDirectory()) continue
    const entries = await readdir(next.path, { withFileTypes: true })
    for (const entry of entries) {
      directories.push({ path: join(next.path, entry.name), category: next.category })
    }
  }

  return tallies
}

const scanUnitMemberUnsafe = async (
  path: string,
  name: string
): Promise<StorageUnitMember | null> => {
  const rootStatus = await lstat(path)
  if (rootStatus.isSymbolicLink()) return null
  const kind = unitKind(rootStatus)
  if (kind === null) return null

  let sizeBytes = rootStatus.isFile() ? requireFileSize(rootStatus) : 0
  let modifiedMilliseconds = rootStatus.mtimeMs
  const entries = rootStatus.isDirectory() ? [path] : []
  let visited = 1
  const fingerprintEntries: Array<{
    readonly path: string
    readonly type: string
    readonly device: number
    readonly inode: number
    readonly size: number
    readonly modifiedMilliseconds: number
    readonly changedMilliseconds: number
  }> = []
  const record = (entryPath: string, status: Stats): void => {
    fingerprintEntries.push({
      path: entryPath === path ? "." : relative(path, entryPath),
      type: fingerprintType(status),
      device: status.dev,
      inode: status.ino,
      size: status.size,
      modifiedMilliseconds: status.mtimeMs,
      changedMilliseconds: status.ctimeMs
    })
  }
  record(path, rootStatus)

  for (let directory = entries.pop(); directory !== undefined; directory = entries.pop()) {
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      visited += 1
      if (visited > MAX_INVENTORY_ENTRIES) {
        throw new Error("Arden storage inventory is too large")
      }
      const childPath = join(directory, child.name)
      const status = await lstat(childPath)
      record(childPath, status)
      if (status.isSymbolicLink()) continue
      modifiedMilliseconds = Math.max(modifiedMilliseconds, status.mtimeMs)
      if (status.isFile()) {
        sizeBytes = addSafe(sizeBytes, requireFileSize(status))
      } else if (status.isDirectory()) {
        entries.push(childPath)
      }
    }
  }

  return {
    name,
    path,
    kind,
    sizeBytes,
    modifiedMilliseconds,
    fingerprint: sha256Hex(
      JSON.stringify(fingerprintEntries.sort((left, right) => left.path.localeCompare(right.path)))
    )
  }
}

const storageUnit = (name: string, members: ReadonlyArray<StorageUnitMember>): StorageUnit => ({
  id: sha256Hex(
    JSON.stringify({
      name,
      members: members.map((member) => ({ name: member.name, fingerprint: member.fingerprint }))
    })
  ),
  name,
  members,
  sizeBytes: members.reduce((total, member) => addSafe(total, member.sizeBytes), 0),
  modifiedMilliseconds: members.reduce(
    (latest, member) => Math.max(latest, member.modifiedMilliseconds),
    0
  )
})

export const scanStorageUnitsUnsafe = async (root: string): Promise<ReadonlyArray<StorageUnit>> => {
  let status: Stats
  try {
    status = await lstat(root)
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return []
    throw cause
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Arden storage root is not a directory")
  }
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.length > MAX_INVENTORY_ENTRIES) {
    throw new Error("Arden storage inventory is too large")
  }
  const names = new Set(entries.map((entry) => entry.name))
  const units: Array<StorageUnit> = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sidecarBase =
      entry.name.endsWith("-wal") || entry.name.endsWith("-shm") ? entry.name.slice(0, -4) : null
    if (sidecarBase !== null && names.has(sidecarBase)) continue

    const memberNames =
      names.has(`${entry.name}-wal`) || names.has(`${entry.name}-shm`)
        ? [entry.name, `${entry.name}-wal`, `${entry.name}-shm`].filter((name) => names.has(name))
        : [entry.name]
    const members: Array<StorageUnitMember> = []
    let valid = true
    for (const memberName of memberNames) {
      const member = await scanUnitMemberUnsafe(join(root, memberName), memberName)
      if (member === null) {
        valid = false
        break
      }
      members.push(member)
    }
    if (valid) units.push(storageUnit(entry.name, members))
  }
  return units.sort(
    (left, right) =>
      right.modifiedMilliseconds - left.modifiedMilliseconds || left.name.localeCompare(right.name)
  )
}
