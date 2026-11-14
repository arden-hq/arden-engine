import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

// How far Memory Capture has read a chat has one owner: `memory_capture_positions`. These keep
// a second copy from coming back: the old marks in `run_sidecars`, or a Capture module that
// depends on the chat's context number, which compaction, clear and revert change.

const SOURCE = join(import.meta.dirname, "../src")

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

/** The backfill that removes the old marks is the one place left that reads them. */
const MARK_REMOVAL = "persistence/sqlite/memory-capture-backlog-backfill.ts"

const CAPTURE_MODULES = [
  "memory/capture-batches.ts",
  "persistence/memory/store.ts",
  "persistence/sqlite/memory.ts",
  "persistence/sqlite/memory-capture-positions.ts",
  "wiki/capture.ts",
  "automations/handlers/memory-capture.ts"
]

it("reads Capture's old marks only in the backfill that removes them", () => {
  const readers = sources(SOURCE)
    .map((path) => relative(SOURCE, path))
    .filter((path) => !path.startsWith("persistence/migrations/"))
    .filter((path) =>
      /\$\.memory_capture(?![_a-z])/u.test(readFileSync(join(SOURCE, path), "utf8"))
    )
  expect(readers).toEqual([MARK_REMOVAL])
})

it("keeps the context number out of every Capture module", () => {
  const naming = CAPTURE_MODULES.filter((path) =>
    /context_generation|contextGeneration/u.test(readFileSync(join(SOURCE, path), "utf8"))
  )
  expect(naming).toEqual([])
})
