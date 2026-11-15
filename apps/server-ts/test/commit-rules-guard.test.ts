import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

const SOURCE = join(import.meta.dirname, "../src")
const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [relative(SOURCE, path)] : []
  })
const naming = (pattern: RegExp): ReadonlyArray<string> =>
  sources(SOURCE)
    .filter((path) => pattern.test(readFileSync(join(SOURCE, path), "utf8")))
    .sort()

it("makes the upkeep writer only through its constructor", () => {
  expect(naming(/kind: "upkeep"/u)).toEqual(["wiki/commit.ts"])
  expect(naming(/\bupkeepOrigin\(/u)).toEqual(["tools/wiki-identity.ts", "wiki/commit.ts"])
  expect(naming(/origin: \{\s*kind: "automation"/u)).toEqual([])
  expect(naming(/\bidempotencyKey\b/u)).toEqual(["wiki/commit.ts"])
})

it("reads a writer's kind only at the commit point, and checks its Space boundary there", () => {
  const wiki = (paths: ReadonlyArray<string>) => paths.filter((path) => path.startsWith("wiki/"))
  expect(wiki(naming(/\.origin\.kind\b/u))).toEqual([])
  expect(naming(/\brequireWikiWritePaths\(/u)).toEqual([
    "wiki/commit.ts",
    "wiki/directories.ts",
    "wiki/rename.ts"
  ])
})

it("tells a merge, a version restore and a report only by the action its one caller states", () => {
  expect(naming(/\bmergePage\(/u)).toEqual(["wiki/mutations.ts"])
  expect(naming(/\bnewPage\(/u)).toEqual(["wiki/mutations.ts"])
  expect(naming(/\brestoreVersion\(/u)).toEqual(["wiki/restore.ts"])
  expect(naming(/(?<!\.)\bpublishReport\(/u)).toEqual(["wiki/reports.ts"])
})

it("keeps a Space's own page at the commit point, and reads ownership elsewhere only to place a new page", () => {
  expect(naming(/\b(isSpacePage|spacePageCheck)\(/u)).toEqual([
    "wiki/commit.ts",
    "wiki/publication.ts"
  ])
  expect(naming(/Move or archive the Space first/iu)).toEqual(["wiki/commit.ts"])
})

it("compares page names in one form, and refuses a taken name for every writer at the commit point", () => {
  expect(naming(/\bpageNamesForPath\(/u)).toEqual(["wiki/page.ts"])
  expect(naming(/\brequireNameFree\b/u)).toEqual(["wiki/commit.ts"])
})
