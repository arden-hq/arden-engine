import { realpathSync } from "node:fs"
import { chmod, lstat, readFile, readdir, rm, unlink } from "node:fs/promises"
import path from "node:path"

import { ensurePrivateDir, isErrnoCode, PrivateFileError, syncDir } from "../../fs/private-store.js"
import {
  MANAGED_OBJECT_HASH,
  MANAGED_OBJECT_PREFIX,
  isManagedObjectSource,
  managedObjectRefParts,
  readManagedObjectDescriptor,
  type ManagedObjectDescriptor,
  type ManagedObjectSource
} from "../../persistence/managed-output/descriptor.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { publishNoReplace } from "@arden-hq/std/publish"

export interface ManagedObjectStore {
  readonly publish: (input: {
    readonly sessionId: string
    readonly text: string
    readonly format: "text" | "json"
    readonly source: ManagedObjectSource
  }) => Promise<ManagedObjectDescriptor>
  readonly read: (input: { readonly sessionId: string; readonly ref: string }) => Promise<string>
  readonly attach: (input: {
    readonly descriptor: ManagedObjectDescriptor
    readonly sessionId: string
    readonly source?: ManagedObjectSource
  }) => Promise<ManagedObjectDescriptor>
  readonly ownerDigests: (sessionId: string) => Promise<ReadonlyArray<string>>
  readonly size: (input: {
    readonly sessionId: string
    readonly ref: string
  }) => Promise<number | undefined>
  readonly removeRef: (input: {
    readonly sessionId: string
    readonly ref: string
  }) => Promise<boolean>
  readonly removeOwner: (sessionId: string) => Promise<void>
  readonly collectDigest: (digest: string) => Promise<boolean>
}

export const isManagedObjectRef = (ref: string): boolean => ref.startsWith(MANAGED_OBJECT_PREFIX)

const objectPath = (root: string, digest: string): string =>
  path.join(root, "objects", digest.slice(0, 2), digest)

const ownerPath = (root: string, descriptor: ManagedObjectDescriptor): string =>
  path.join(
    root,
    "refs",
    descriptor.owner_session_hash,
    `${descriptor.sha256}.${descriptor.format}.json`
  )

const ownerRecord = (descriptor: ManagedObjectDescriptor) => ({
  ref: descriptor.ref,
  sha256: descriptor.sha256,
  bytes: descriptor.bytes,
  format: descriptor.format,
  owner_session_hash: descriptor.owner_session_hash
})

type OwnerRecord = ReturnType<typeof ownerRecord>
const REF_FILE = /^([a-f0-9]{64})\.(text|json)\.json$/u

const ensurePrivate = async (directory: string): Promise<void> => {
  const created = await ensurePrivateDir(directory).catch((cause: unknown) => {
    if (cause instanceof PrivateFileError)
      throw new Error("Managed-output directory is unsafe", { cause })
    throw cause
  })
  if (created !== undefined) await syncDir(path.dirname(created))
}

const publishImmutable = async (target: string, bytes: Buffer): Promise<void> => {
  await ensurePrivate(path.dirname(target))
  if (!(await publishNoReplace(target, bytes))) {
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isFile() || !(await readFile(target)).equals(bytes)) {
      throw new Error("Managed-output destination differs from immutable content")
    }
  }
  await chmod(target, 0o600)
  await syncDir(path.dirname(target))
}

export const makeManagedObjectStore = (root: string): ManagedObjectStore => {
  if (!path.isAbsolute(root)) throw new Error("Managed-output root must be absolute")
  const resolved = path.resolve(root)
  const directory = path.join(realpathSync(path.dirname(resolved)), path.basename(resolved))

  const verify = async (record: OwnerRecord): Promise<string> => {
    for (const parent of [
      directory,
      path.join(directory, "refs"),
      path.join(directory, "refs", record.owner_session_hash),
      path.join(directory, "objects"),
      path.join(directory, "objects", record.sha256.slice(0, 2))
    ]) {
      const info = await lstat(parent)
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Unsafe managed-output directory")
    }
    const refFile = path.join(
      directory,
      "refs",
      record.owner_session_hash,
      `${record.sha256}.${record.format}.json`
    )
    const refInfo = await lstat(refFile)
    if (refInfo.isSymbolicLink() || !refInfo.isFile())
      throw new Error("Unsafe managed-output owner ref")
    const saved: unknown = JSON.parse(await readFile(refFile, "utf8"))
    if (JSON.stringify(saved) !== JSON.stringify(record)) {
      throw new Error("Managed-output owner ref differs")
    }
    const object = objectPath(directory, record.sha256)
    const info = await lstat(object)
    if (info.isSymbolicLink() || !info.isFile() || info.size !== record.bytes) {
      throw new Error("Managed-output object is missing or corrupt")
    }
    const bytes = await readFile(object)
    if (sha256Hex(bytes) !== record.sha256) throw new Error("Managed-output object hash differs")
    const text = bytes.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new Error("Managed-output object is not UTF-8")
    return text
  }

  const publish: ManagedObjectStore["publish"] = async (input) => {
    if (input.sessionId.length === 0 || !isManagedObjectSource(input.source))
      throw new Error("Invalid managed-output owner or source")
    const bytes = Buffer.from(input.text, "utf8")
    const owner = sha256Hex(input.sessionId)
    const digest = sha256Hex(bytes)
    const descriptor: ManagedObjectDescriptor = {
      kind: "managed_output",
      ref: `${MANAGED_OBJECT_PREFIX}${owner}/${digest}/${input.format}`,
      sha256: digest,
      bytes: bytes.byteLength,
      format: input.format,
      owner_session_hash: owner,
      source: input.source
    }
    await ensurePrivate(directory)
    await ensurePrivate(path.join(directory, "objects"))
    await ensurePrivate(path.join(directory, "refs"))
    await publishImmutable(objectPath(directory, digest), bytes)
    await publishImmutable(
      ownerPath(directory, descriptor),
      Buffer.from(JSON.stringify(ownerRecord(descriptor)), "utf8")
    )
    return descriptor
  }

  const read: ManagedObjectStore["read"] = async (input) => {
    const parsed = managedObjectRefParts(input.ref)
    if (parsed === undefined || parsed.owner !== sha256Hex(input.sessionId)) {
      throw new Error("Managed-output ref is not owned by this Session")
    }
    for (const parent of [
      directory,
      path.join(directory, "refs"),
      path.join(directory, "refs", parsed.owner)
    ]) {
      const info = await lstat(parent)
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Unsafe managed-output owner directory")
    }
    const refFile = path.join(
      directory,
      "refs",
      parsed.owner,
      `${parsed.digest}.${parsed.format}.json`
    )
    const refInfo = await lstat(refFile)
    if (refInfo.isSymbolicLink() || !refInfo.isFile())
      throw new Error("Unsafe managed-output owner ref")
    const saved: unknown = JSON.parse(await readFile(refFile, "utf8"))
    if (
      typeof saved !== "object" ||
      saved === null ||
      !("ref" in saved) ||
      saved.ref !== input.ref ||
      !("bytes" in saved) ||
      typeof saved.bytes !== "number" ||
      !Number.isSafeInteger(saved.bytes) ||
      saved.bytes < 0
    ) {
      throw new Error("Managed-output owner ref is invalid")
    }
    return verify({
      ref: input.ref,
      sha256: parsed.digest,
      bytes: saved.bytes,
      format: parsed.format,
      owner_session_hash: parsed.owner
    })
  }

  const attach: ManagedObjectStore["attach"] = async (input) => {
    const valid = readManagedObjectDescriptor(input.descriptor)
    if (valid === undefined) throw new Error("Invalid managed-output descriptor")
    const text = await verify(ownerRecord(valid))
    return publish({
      sessionId: input.sessionId,
      text,
      format: input.descriptor.format,
      source: input.source ?? input.descriptor.source
    })
  }

  const removeOwner: ManagedObjectStore["removeOwner"] = async (sessionId) => {
    if (sessionId.length === 0) throw new Error("Invalid managed-output owner")
    const refs = path.join(directory, "refs")
    try {
      for (const parent of [directory, refs]) {
        const info = await lstat(parent)
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Unsafe managed-output directory")
      }
      const owner = path.join(refs, sha256Hex(sessionId))
      const info = await lstat(owner)
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Unsafe managed-output owner directory")
      await rm(owner, { recursive: true })
      await syncDir(refs)
    } catch (cause) {
      if (!isErrnoCode(cause, "ENOENT")) throw cause
    }
  }

  const size: ManagedObjectStore["size"] = async (input) => {
    const parsed = managedObjectRefParts(input.ref)
    if (parsed === undefined || parsed.owner !== sha256Hex(input.sessionId)) return undefined
    const refFile = path.join(
      directory,
      "refs",
      parsed.owner,
      `${parsed.digest}.${parsed.format}.json`
    )
    try {
      const info = await lstat(refFile)
      if (info.isSymbolicLink() || !info.isFile()) return undefined
      const saved: unknown = JSON.parse(await readFile(refFile, "utf8"))
      return typeof saved === "object" &&
        saved !== null &&
        "bytes" in saved &&
        typeof saved.bytes === "number"
        ? saved.bytes
        : undefined
    } catch (cause) {
      if (isErrnoCode(cause, "ENOENT")) return undefined
      throw cause
    }
  }

  const removeRef: ManagedObjectStore["removeRef"] = async (input) => {
    const parsed = managedObjectRefParts(input.ref)
    if (parsed === undefined || parsed.owner !== sha256Hex(input.sessionId)) {
      throw new Error("Managed-output ref is not owned by this Session")
    }
    const owner = path.join(directory, "refs", parsed.owner)
    try {
      for (const parent of [directory, path.join(directory, "refs"), owner]) {
        const info = await lstat(parent)
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Unsafe managed-output owner directory")
      }
      const refFile = path.join(owner, `${parsed.digest}.${parsed.format}.json`)
      const info = await lstat(refFile)
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error("Unsafe managed-output owner ref")
      await unlink(refFile)
      await syncDir(owner)
      return true
    } catch (cause) {
      if (isErrnoCode(cause, "ENOENT")) return false
      throw cause
    }
  }

  const ownerDigests: ManagedObjectStore["ownerDigests"] = async (sessionId) => {
    if (sessionId.length === 0) throw new Error("Invalid managed-output owner")
    const refs = path.join(directory, "refs")
    const owner = path.join(refs, sha256Hex(sessionId))
    try {
      for (const parent of [directory, refs, owner]) {
        const info = await lstat(parent)
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error("Unsafe managed-output directory")
      }
    } catch (cause) {
      if (isErrnoCode(cause, "ENOENT")) return []
      throw cause
    }
    const digests = new Set<string>()
    for (const entry of await readdir(owner, { withFileTypes: true })) {
      const digest = REF_FILE.exec(entry.name)?.[1]
      if (digest === undefined || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Unsafe managed-output ref entry")
      }
      digests.add(digest)
    }
    return [...digests]
  }

  const collectDigest: ManagedObjectStore["collectDigest"] = async (digest) => {
    if (!MANAGED_OBJECT_HASH.test(digest)) throw new Error("Invalid managed-output digest")
    const refs = path.join(directory, "refs")
    const objects = path.join(directory, "objects")
    for (const parent of [directory, refs, objects]) {
      const info = await lstat(parent)
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Unsafe managed-output directory")
    }
    for (const owner of await readdir(refs, { withFileTypes: true })) {
      if (!MANAGED_OBJECT_HASH.test(owner.name) || !owner.isDirectory() || owner.isSymbolicLink()) {
        throw new Error("Unsafe managed-output owner entry")
      }
      const ownerDirectory = path.join(refs, owner.name)
      for (const format of ["text", "json"]) {
        try {
          const info = await lstat(path.join(ownerDirectory, `${digest}.${format}.json`))
          if (info.isSymbolicLink() || !info.isFile())
            throw new Error("Unsafe managed-output ref entry")
          return false
        } catch (cause) {
          if (!isErrnoCode(cause, "ENOENT")) throw cause
        }
      }
    }
    const folder = path.join(objects, digest.slice(0, 2))
    const object = path.join(folder, digest)
    try {
      const parent = await lstat(folder)
      const info = await lstat(object)
      if (
        parent.isSymbolicLink() ||
        !parent.isDirectory() ||
        info.isSymbolicLink() ||
        !info.isFile()
      ) {
        throw new Error("Unsafe managed-output object entry")
      }
      await unlink(object)
      await syncDir(folder)
      return true
    } catch (cause) {
      if (!isErrnoCode(cause, "ENOENT")) throw cause
      return false
    }
  }

  return { publish, read, attach, ownerDigests, size, removeRef, removeOwner, collectDigest }
}
