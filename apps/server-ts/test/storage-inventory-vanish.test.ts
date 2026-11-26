import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  scanInventoryUnsafe,
  scanStorageUnitsUnsafe,
  type ScanFileSystem
} from "../src/storage/inventory.js"

const vanished = new Set<string>()
const gone = (path: unknown): boolean =>
  typeof path === "string" && [...vanished].some((name) => path.endsWith(name))
const missing = (path: unknown): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${String(path)}'`), {
    code: "ENOENT"
  })
const vanishing: ScanFileSystem = {
  lstat: (async (path: never, ...rest: Array<never>) => {
    if (gone(path)) throw missing(path)
    return lstat(path, ...rest)
  }) as typeof lstat,
  readdir: (async (path: never, ...rest: Array<never>) => {
    if (gone(path)) throw missing(path)
    return readdir(path, ...rest)
  }) as typeof readdir
}

describe("storage scan while files come and go", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "arden-inventory-"))
    await mkdir(join(root, "kept", "inner"), { recursive: true })
    await writeFile(join(root, "kept", "a.txt"), "aaaa")
    await writeFile(join(root, "kept", "inner", "temp.part"), "bbbbbbbb")
    await mkdir(join(root, "kept", "leaving"))
    await writeFile(join(root, "top.tmp"), "cc")
  })

  afterEach(async () => {
    vanished.clear()
    await rm(root, { recursive: true, force: true })
  })

  it("leaves out a file, a folder and a top entry that vanish, and keeps the rest", async () => {
    const before = await scanStorageUnitsUnsafe(root, vanishing)
    expect(before.map((unit) => unit.name).sort()).toEqual(["kept", "top.tmp"])

    vanished.add("temp.part").add("leaving").add("top.tmp")
    const after = await scanStorageUnitsUnsafe(root, vanishing)
    expect(after.map((unit) => unit.name)).toEqual(["kept"])
    expect(after[0]?.sizeBytes).toBe(4)
  })

  it("still fails on an error that is not a vanished entry", async () => {
    const denied: ScanFileSystem = {
      lstat,
      readdir: (async (path: never, ...rest: Array<never>) => {
        if (String(path).endsWith("inner")) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
        }
        return readdir(path, ...rest)
      }) as typeof readdir
    }
    await expect(scanStorageUnitsUnsafe(root, denied)).rejects.toThrow()
    await expect(scanInventoryUnsafe(root, null, denied)).rejects.toThrow()
    await expect(scanInventoryUnsafe(join(root, "kept", "a.txt"), null)).rejects.toThrow()
  })
})
