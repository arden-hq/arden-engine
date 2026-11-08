import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  prepareReleaseStorage,
  recordDataVersion
} from "../src/persistence/sqlite/release-safety.js"

let directory = ""
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "arden-release-safety-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const open = (appVersion: string) =>
  Effect.runPromiseExit(
    prepareReleaseStorage(join(directory, "arden.db"), { appVersion, dataDir: directory })
  )

describe("the data version guard", () => {
  it.each([
    { recorded: undefined, current: "1.0.1-beta.1", opens: "1.0.1-beta.1" },
    { recorded: "1.0.1-beta.1", current: "1.0.1-beta.2", opens: "1.0.1-beta.2" },
    { recorded: "1.0.1-beta.2", current: "1.0.1-beta.10", opens: "1.0.1-beta.10" },
    { recorded: "1.0.1-beta.10", current: "1.0.1", opens: "1.0.1" },
    { recorded: "1.0.1", current: "1.1.0", opens: "1.1.0" },
    { recorded: "1.0.1-beta.2", current: "1.0.1-beta.2", opens: undefined },
    { recorded: "1.0.1", current: "0.0.0-dev", opens: undefined },
    { recorded: "garbage", current: "1.0.1", opens: "1.0.1" }
  ])("opens $current over data recorded by $recorded", async ({ recorded, current, opens }) => {
    if (recorded !== undefined)
      await writeFile(join(directory, "app-version.json"), JSON.stringify({ version: recorded }))
    const exit = await open(current)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(Exit.isSuccess(exit) ? exit.value?.version : "failed").toBe(opens)
  })

  it.each([
    { recorded: "1.0.1", current: "1.0.1-beta.2" },
    { recorded: "1.1.0", current: "1.0.9" },
    { recorded: "2.0.0", current: "1.9.9" }
  ])("refuses $current over data a newer $recorded opened", async ({ recorded, current }) => {
    await writeFile(join(directory, "app-version.json"), JSON.stringify({ version: recorded }))
    const exit = await open(current)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      operation: "open_newer_data",
      message: `This data was last opened by Arden ${recorded}, which is newer than this Arden ${current}. Install ${recorded} or newer.`
    })
  })

  it("records the opening version so an older app is then refused", async () => {
    const storage = { appVersion: "1.0.2", dataDir: directory }
    await Effect.runPromise(recordDataVersion(storage, "1.0.2"))
    expect(JSON.parse(await readFile(join(directory, "app-version.json"), "utf8"))).toEqual({
      version: "1.0.2"
    })
    const older = await open("1.0.1")
    expect(Exit.isFailure(older) ? Cause.squash(older.cause) : undefined).toMatchObject({
      operation: "open_newer_data"
    })
  })
})
