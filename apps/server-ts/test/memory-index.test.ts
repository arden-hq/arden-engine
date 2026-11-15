import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { memoryIndex } from "../src/wiki/collections.js"
import { formatWikiPage, parseWikiPage, wikiPageSummary } from "../src/wiki/page.js"
import type { PageRecord } from "../src/wiki/snapshot.js"

// Made-up pages; nothing here comes from anyone's Memory.

const page = (
  path: string,
  body = `About ${path}. More detail follows here.`,
  options: {
    readonly summary?: string
    readonly lifecycle?: "active" | "redirect"
    readonly state?: "active" | "archived"
  } = {}
): PageRecord => {
  const pageId = `id-${path}`
  return {
    resource: {
      resourceId: pageId,
      path,
      blobId: `blob-${path}`,
      state: options.state ?? "active",
      versionId: `version-${path}`
    },
    page: Effect.runSync(
      parseWikiPage(
        formatWikiPage({
          pageId,
          title: path,
          aliases: [],
          lifecycle: options.lifecycle ?? "active",
          redirectTo: options.lifecycle === "redirect" ? "id-README.md" : null,
          metadata: options.summary === undefined ? {} : { summary: options.summary },
          body
        }),
        pageId
      )
    )
  }
}

const folder = (name: string, count: number): ReadonlyArray<PageRecord> =>
  Array.from({ length: count }, (_, index) => page(`${name}/page-${index}.md`))

const PAGES: ReadonlyArray<PageRecord> = [
  page("README.md"),
  page("active-work.md"),
  ...folder("daily", 30),
  ...folder("topics", 12),
  ...folder("topics/deep", 4),
  ...folder("people", 3),
  page("people/old.md", "Old.", { lifecycle: "redirect" }),
  page("people/gone.md", "Gone.", { state: "archived" })
]
const ACTIVE = PAGES.length - 2

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength

describe("the Memory index", () => {
  it("lists every active page once, or counts it in a folded folder, at every size", () => {
    for (let maxBytes = 0; maxBytes <= 8_000; maxBytes += 250) {
      const index = memoryIndex(PAGES, { root: "", maxBytes })
      const listed = index.lines.map((line) => line.path)
      expect(new Set(listed).size).toBe(listed.length)
      expect(listed.length + index.folded.reduce((sum, fold) => sum + fold.pages, 0)).toBe(ACTIVE)
      expect(listed).not.toContain("people/old.md")
      expect(listed).not.toContain("people/gone.md")
      expect(index.bytes).toBe(bytes(index.text))
    }
  })

  it("fits its size by folding the folder with the most direct pages first, the root last", () => {
    const whole = memoryIndex(PAGES, { root: "", maxBytes: 1_000_000 })
    expect(whole.folded).toEqual([])
    expect(whole.lines).toHaveLength(ACTIVE)
    const order = ["daily", "topics", "topics/deep", "people", ""]
    for (let maxBytes = whole.bytes; maxBytes >= 0; maxBytes -= 50) {
      const index = memoryIndex(PAGES, { root: "", maxBytes })
      const folded = index.folded.map((fold) => fold.folder)
      expect(folded).toEqual(order.slice(0, folded.length))
      if (folded.length < order.length) expect(index.bytes).toBeLessThanOrEqual(maxBytes)
    }
    const tight = memoryIndex(PAGES, { root: "", maxBytes: whole.bytes - 500 })
    expect(tight.folded).toEqual([{ folder: "daily", pages: 30 }])
  })

  it("keeps a folded folder in path order, as one counted line", () => {
    const whole = memoryIndex(PAGES, { root: "", maxBytes: 1_000_000 })
    const index = memoryIndex(PAGES, { root: "", maxBytes: whole.bytes - 500 })
    const text = index.text.split("\n")
    expect(text.filter((line) => line.startsWith("- daily/"))).toEqual([
      "- daily/ (30 pages, folded)"
    ])
    expect(text).toEqual(
      text.toSorted((left, right) => left.slice(2).localeCompare(right.slice(2)))
    )
  })

  it("lists only the pages under its root folder", () => {
    const index = memoryIndex(PAGES, { root: "topics", maxBytes: 1_000_000 })
    expect(index.lines.map((line) => line.path).every((path) => path.startsWith("topics/"))).toBe(
      true
    )
    expect(index.lines).toHaveLength(16)
  })

  it("leaves out the pages the caller sends another way", () => {
    const index = memoryIndex(PAGES, {
      root: "",
      maxBytes: 1_000_000,
      leaveOut: (record) => record.resource.path === "README.md"
    })
    expect(index.lines.map((line) => line.path)).not.toContain("README.md")
    expect(index.lines).toHaveLength(ACTIVE - 1)
  })
})

describe("a page's summary line", () => {
  it("is the page's summary field when it has one", () => {
    const record = page("notes/a.md", "First sentence here. Second one.", {
      summary: "  The   chosen summary. "
    })
    expect(wikiPageSummary(record.page, 120)).toBe("The chosen summary.")
  })

  it("is else the first sentence of its text, cut to the limit", () => {
    expect(wikiPageSummary(page("notes/a.md", "# Title\n\nFirst one. Second.").page, 120)).toBe(
      "First one."
    )
    const long = wikiPageSummary(page("notes/b.md", `${"word ".repeat(60)}end.`).page, 40)
    expect(long?.length).toBeLessThanOrEqual(40)
    expect(wikiPageSummary(page("notes/c.md", "").page, 120)).toBeNull()
  })
})
