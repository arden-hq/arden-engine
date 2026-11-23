import { Effect } from "effect"
import { expect, it } from "vitest"
import { memoryIndex } from "../src/wiki/collections.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { runPage } from "./kit.js"

const page = (path: string, lifecycle: "active" | "redirect" = "active") => {
  const pageId = `id-${path}`
  const text = formatWikiPage({
    pageId,
    title: path,
    aliases: [],
    lifecycle,
    redirectTo: lifecycle === "redirect" ? "id-README.md" : null,
    metadata: {},
    body: `About ${path}.`
  })
  return runPage({
    resource: { resourceId: pageId, path, blobId: path, state: "active", versionId: path },
    page: Effect.runSync(parseWikiPage(text, pageId))
  })
}

it("lists each active page once, folded or counted as cut, within every size", () => {
  const folder = (name: string, count: number) =>
    Array.from({ length: count }, (_, index) => page(`${name}/page-${index}.md`))
  const pages = [
    page("README.md"),
    ...folder("daily", 30),
    ...folder("topics", 12),
    page("old.md", "redirect")
  ]
  for (let maxBytes = 0; maxBytes <= 4_000; maxBytes += 1) {
    const index = memoryIndex(pages, { root: "", maxBytes })
    const listed = index.lines.map((line) => line.path)
    const counted =
      listed.length + index.folded.reduce((sum, fold) => sum + fold.pages, 0) + index.unlisted
    expect(new Set(listed).size).toBe(listed.length)
    expect(counted).toBe(pages.length - 1)
    expect(listed).not.toContain("old.md")
    expect(index.bytes).toBeLessThanOrEqual(maxBytes)
  }
})

it("lists only the pages under its root", () => {
  const pages = [
    page("README.md"),
    ...Array.from({ length: 5 }, (_, index) => page(`daily/page-${index}.md`)),
    ...Array.from({ length: 3 }, (_, index) => page(`topics/page-${index}.md`))
  ]
  const index = memoryIndex(pages, { root: "topics", maxBytes: 100_000 })
  expect(index.lines.map((line) => line.path)).toEqual([
    "topics/page-0.md",
    "topics/page-1.md",
    "topics/page-2.md"
  ])
})
