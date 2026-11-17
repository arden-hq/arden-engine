import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Names that "vanish": listed by readdir, gone by the time the scan reads them.
const vanished = vi.hoisted(() => new Set<string>())

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>()
  const gone = (path: unknown): boolean =>
    typeof path === "string" && [...vanished].some((name) => path.endsWith(name))
  const missing = (path: unknown): Error =>
    Object.assign(new Error(`ENOENT: no such file or directory, '${String(path)}'`), {
      code: "ENOENT"
    })
  return {
    ...real,
    lstat: (async (path: never, ...rest: Array<never>) => {
      if (gone(path)) throw missing(path)
      return real.lstat(path, ...rest)
    }) as typeof real.lstat,
    readdir: (async (path: never, ...rest: Array<never>) => {
      if (gone(path)) throw missing(path)
      return real.readdir(path, ...rest)
    }) as typeof real.readdir
  }
})

const { scanInventoryUnsafe, scanStorageUnitsUnsafe } = await import("../src/storage/inventory.js")

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
    const before = await scanStorageUnitsUnsafe(root)
    expect(before.map((unit) => unit.name).sort()).toEqual(["kept", "top.tmp"])

    vanished.add("temp.part").add("leaving").add("top.tmp")
    const after = await scanStorageUnitsUnsafe(root)
    expect(after.map((unit) => unit.name)).toEqual(["kept"])
    expect(after[0]?.sizeBytes).toBe(4)
  })

  it("the totals scan leaves them out too", async () => {
    vanished.add("temp.part").add("leaving").add("top.tmp")
    const tallies = await scanInventoryUnsafe(root, null)
    const bytes = Object.values(tallies).reduce((total, tally) => total + tally.totalBytes, 0)
    expect(bytes).toBe(4)
  })

  it("still fails on an error that is not a vanished entry", async () => {
    await expect(scanInventoryUnsafe(join(root, "kept", "a.txt"), null)).rejects.toThrow(
      "Arden storage root is not a directory"
    )
  })
})
