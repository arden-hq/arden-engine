import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { cliAccessPath, publishCliAccess, withdrawCliAccess } from "../src/runtime/cli-access.js"

const directories: Array<string> = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const access = (capability: string) => ({
  version: 1 as const,
  serverUrl: "http://127.0.0.1:51234/",
  capability,
  pid: 4242
})

const tempDatabase = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-cli-access-"))
  directories.push(directory)
  return join(directory, "arden.db")
}

describe("CLI access file", () => {
  it("is written beside the database, readable by its owner only", async () => {
    const path = cliAccessPath(await tempDatabase())
    await publishCliAccess(path, access("a".repeat(43)))

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(access("a".repeat(43)))
  })

  it("is removed only by the daemon it names", async () => {
    const path = cliAccessPath(await tempDatabase())
    await publishCliAccess(path, access("new".padEnd(43, "n")))

    await withdrawCliAccess(path, "old".padEnd(43, "o"))
    expect(JSON.parse(await readFile(path, "utf8")).capability).toBe("new".padEnd(43, "n"))

    await withdrawCliAccess(path, "new".padEnd(43, "n"))
    await expect(stat(path)).rejects.toThrow()
  })
})
