import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { snapshotOf, type PageRecord } from "../src/wiki/snapshot.js"

const ROOTS = {
  src: join(import.meta.dirname, "../src"),
  scripts: join(import.meta.dirname, "../scripts"),
  test: import.meta.dirname
}

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

const filesMatching = (pattern: RegExp, roots: ReadonlyArray<string>): ReadonlyArray<string> =>
  roots
    .flatMap((root) =>
      sources(root)
        .filter((path) => pattern.test(readFileSync(path, "utf8")))
        .map((path) => relative(join(import.meta.dirname, ".."), path))
    )
    .sort()

const HASH = "0".repeat(64)

const page = (path: string): PageRecord => ({
  resource: { resourceId: `id:${path}`, path, blobId: HASH, state: "active", versionId: HASH },
  page: Effect.runSync(
    parseWikiPage(
      formatWikiPage({
        pageId: `id:${path}`,
        title: path,
        aliases: [],
        lifecycle: "active",
        redirectTo: null,
        metadata: {},
        body: `About ${path}.`
      }),
      `id:${path}`
    )
  )
})

it("shows a run every page but the code-owned ones, and keeps the whole set apart", () => {
  const snapshot = snapshotOf("head", [page("forgotten.md"), page("topics/garden.md")])
  expect(snapshot.pages.map((record) => record.resource.path)).toEqual(["topics/garden.md"])
  expect(snapshot.wholeSet.map((record) => record.resource.path)).toEqual([
    "forgotten.md",
    "topics/garden.md"
  ])
})

it("reads the whole set only in consistency checks, the owner's routes and diagnostics", () => {
  expect(filesMatching(/\.wholeSet\b/u, [ROOTS.src, ROOTS.scripts])).toEqual([
    "scripts/memory-shape.ts",
    "src/automations/handlers/daily-summary.ts",
    "src/tools/session-actions.ts",
    "src/wiki/conflict.ts",
    "src/wiki/content-steps.ts",
    "src/wiki/directories.ts",
    "src/wiki/forgotten.ts",
    "src/wiki/history.ts",
    "src/wiki/imported.ts",
    "src/wiki/listing.ts",
    "src/wiki/mutations.ts",
    "src/wiki/outside-edits.ts",
    "src/wiki/rename.ts",
    "src/wiki/reports.ts",
    "src/wiki/restore.ts",
    "src/wiki/snapshot.ts",
    "src/wiki/space-page.ts",
    "src/wiki/write-rules.ts"
  ])
})

it("makes a run page only through the run view, never by a cast", () => {
  expect(filesMatching(/\bas\s+(?:Readonly)?(?:Array<)?RunPage\b/u, Object.values(ROOTS))).toEqual(
    []
  )
  expect(filesMatching(/\bshownToRuns\]/u, Object.values(ROOTS))).toEqual(["src/wiki/snapshot.ts"])
})
