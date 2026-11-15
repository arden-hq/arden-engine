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
