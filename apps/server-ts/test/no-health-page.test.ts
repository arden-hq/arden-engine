import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

const ROOTS = [
  join(import.meta.dirname, "../src"),
  join(import.meta.dirname, "../../../libs/protocol/src")
]

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(?:ts|md)$/u.test(entry.name) ? [path] : []
  })

const NAMES_HEALTH_PAGE =
  /(?<![\w/])health\.md\b|(?:pageId|page_id)\s*[!=]==\s*"health"|"health"\)\s*\{/u

it("names no derived health page anywhere in the server or the protocol", () => {
  const naming = ROOTS.flatMap((root) =>
    sources(root)
      .filter((path) => NAMES_HEALTH_PAGE.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path))
  )
  expect(naming).toEqual([])
})
