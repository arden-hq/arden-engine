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
})

it("decides what a writer may do only at the commit point", () => {
  const wiki = (paths: ReadonlyArray<string>) => paths.filter((path) => path.startsWith("wiki/"))
  expect(wiki(naming(/\.origin\.kind\b/u))).toEqual(["wiki/commit.ts"])
  expect(naming(/from "\.\/commit\.js"/u)).not.toContain("wiki/write-rules.ts")
})

it("tells a merge, a version restore, a report and a link rewrite only by the action its one caller states", () => {
  expect(naming(/\bmergePage\(/u)).toEqual(["wiki/mutations.ts"])
  expect(naming(/\brestoreVersion\(/u)).toEqual(["wiki/restore.ts"])
  expect(naming(/(?<!\.)\bpublishReport\(/u)).toEqual(["wiki/reports.ts"])
  expect(naming(/\brewriteLinks\(/u)).toEqual(["wiki/rename.ts"])
})

it("keeps a Space's own page at the commit point, and reads ownership elsewhere only to place a new page", () => {
  expect(naming(/\bisSpacePage\(/u)).toEqual([
    "wiki/commit.ts",
    "wiki/publication.ts",
    "wiki/write-rules.ts"
  ])
  const writeRules = readFileSync(join(SOURCE, "wiki/write-rules.ts"), "utf8")
  expect(writeRules.match(/\bisSpacePage\(/gu)).toHaveLength(1)
  expect(writeRules).toMatch(/requireCreatable[\s\S]*\bisSpacePage\(/u)
  expect(naming(/Move or archive the Space first/iu)).toEqual(["wiki/commit.ts"])
})
