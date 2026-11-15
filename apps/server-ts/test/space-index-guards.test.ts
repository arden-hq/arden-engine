import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SOURCE = join(import.meta.dirname, "../src")

const sources = (): ReadonlyArray<{ readonly path: string; readonly text: string }> =>
  readdirSync(SOURCE, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => ({ path, text: readFileSync(join(SOURCE, path), "utf8") }))

const where = (pattern: RegExp): ReadonlyArray<string> =>
  sources()
    .filter((file) => pattern.test(file.text))
    .map((file) => relative(".", file.path))
    .sort()

const callingSpaceStore = (method: string): ReadonlyArray<string> =>
  sources()
    .filter((file) => {
      const names = [...file.text.matchAll(/const (\w+) = yield\* SpaceStore\b/gu)].map(
        (match) => match[1]
      )
      return [...names, "spaces"].some((name) =>
        new RegExp(`\\b${name}\\s*\\.${method}\\(`, "u").test(file.text)
      )
    })
    .map((file) => file.path)
    .sort()

describe("only wiki/space-index.ts decides which pages a Space owns", () => {
  it("leaves no second copy of the rule", () => {
    expect(
      where(
        /\b(wikiPathWithinSpaceBoundary|wikiSpaceBoundariesOverlap|wikiBoundaryRoot|hasPageBinding|ownsWikiPath)\b/u
      )
    ).toEqual([])
  })

  it("reads the active bindings only to apply its rules", () => {
    expect(where(/\.activeBindings\(\)/u)).toEqual(["wiki/space-index.ts"])
    const reads = sources().flatMap((file) => [...file.text.matchAll(/\.activeBindings\(\)/gu)])
    expect(reads).toHaveLength(1)
  })

  it("filters Space rows by their page in one store file only", () => {
    expect(
      where(/\b(FROM|UPDATE) spaces\b[^`]*\bWHERE[^`]*\b(page_id|page_path)\s*(=|<>|!=|IN)\s/u)
    ).toEqual(["persistence/sqlite/spaces.ts"])
  })
})

describe("one create-and-bind gives a Space its page", () => {
  it("binds, restores and makes Space pages only in wiki/space-page.ts", () => {
    expect(where(/\.bindPage\(/u)).toEqual(["wiki/space-page.ts"])
    expect(where(/\bas FreeSpacePage\b/u)).toEqual(["wiki/space-index.ts"])
    expect(callingSpaceStore("restore")).toEqual(["wiki/space-page.ts"])
    expect(where(/\bcreateSpacePage\(/u)).toEqual(["wiki/space-page.ts"])
  })

  it("creates Spaces only through createSpaceWithPage", () => {
    expect(callingSpaceStore("create")).toEqual(["wiki/space-page.ts"])
    expect(where(/\bcreateSpaceWithPage\(/u)).toEqual([
      "assist/session-triage.ts",
      "http/spaces/handlers.ts",
      "tools/space-controls.ts"
    ])
  })
})
