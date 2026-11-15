import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

const SOURCE_ROOTS = [
  join(import.meta.dirname, "../src"),
  join(import.meta.dirname, "../../../libs/protocol/src")
]

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(?:ts|md)$/u.test(entry.name) ? [path] : []
  })

it("names a code-owned page only in the one predicate", () => {
  const naming = SOURCE_ROOTS.flatMap((root) =>
    sources(root)
      .filter((path) => /forgotten\.md/u.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path))
  )
  expect(naming).toEqual(["wiki/system-pages.ts"])
})

it("decides what a run sees of code-owned pages in the run view alone", () => {
  const deciding = SOURCE_ROOTS.flatMap((root) =>
    sources(root)
      .filter((path) => /\bisSystemPage\(/u.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path))
  ).sort()
  expect(deciding).toEqual([
    "wiki/change.ts",
    "wiki/commit.ts",
    "wiki/links.ts",
    "wiki/snapshot.ts"
  ])
})
