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
  page("ideas.md"),
  page("inbox.md"),
  page("plans.md"),
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
  it("fits every size, and lists each active page once, folds it or counts it as cut", () => {
    for (let maxBytes = 0; maxBytes <= 8_000; maxBytes += 250) {
      const index = memoryIndex(PAGES, { root: "", maxBytes })
      const listed = index.lines.map((line) => line.path)
      expect(new Set(listed).size).toBe(listed.length)
      expect(
        listed.length + index.folded.reduce((sum, fold) => sum + fold.pages, 0) + index.unlisted
      ).toBe(ACTIVE)
      expect(listed).not.toContain("people/old.md")
      expect(listed).not.toContain("people/gone.md")
      expect(index.bytes).toBe(bytes(index.text))
      expect(index.bytes).toBeLessThanOrEqual(maxBytes)
    }
  })

  it("cuts lines from the end only once every folder that can fold is folded", () => {
    const singles = Array.from({ length: 700 }, (_, index) =>
      page(`folder-${String(index).padStart(3, "0")}/only.md`, "")
    )
    const index = memoryIndex(singles, { root: "", maxBytes: 10_000 })
    expect(index.bytes).toBeLessThanOrEqual(10_000)
    expect(index.unlisted).toBeGreaterThan(0)
    expect(index.lines.length + index.folded.length + index.unlisted).toBe(700)
    expect(index.lines.at(-1)?.path ?? "").not.toBe("folder-699/only.md")
    expect(memoryIndex(PAGES, { root: "", maxBytes: 1_000_000 }).unlisted).toBe(0)
  })

  it("fits its size by folding the folder with the most direct pages first, the root last", () => {
    const whole = memoryIndex(PAGES, { root: "", maxBytes: 1_000_000 })
    expect(whole.folded).toEqual([])
    expect(whole.lines).toHaveLength(ACTIVE)
    const order = ["daily", "topics", "topics/deep", "people", ""]
    for (let maxBytes = whole.bytes; maxBytes >= 0; maxBytes -= 50) {
      const index = memoryIndex(PAGES, { root: "", maxBytes })
      const folded = index.folded.map((fold) => fold.folder)
      if (index.unlisted === 0) expect(folded).toEqual(order.slice(0, folded.length))
    }
    const tight = memoryIndex(PAGES, { root: "", maxBytes: whole.bytes - 500 })
    expect(tight.folded).toEqual([{ folder: "daily", pages: 30 }])
  })

  it("keeps a folded folder in path order, as one line with no count", () => {
    const whole = memoryIndex(PAGES, { root: "", maxBytes: 1_000_000 })
    const index = memoryIndex(PAGES, { root: "", maxBytes: whole.bytes - 500 })
    const text = index.text.split("\n")
    expect(text.filter((line) => line.startsWith("- daily/"))).toEqual(["- daily/ (folded)"])
    expect(text).toEqual(
      text.toSorted((left, right) => left.slice(2).localeCompare(right.slice(2)))
    )
  })

  it("keeps its text when a page is added to or leaves a folded folder", () => {
    const whole = memoryIndex(PAGES, { root: "", maxBytes: 1_000_000 })
    const maxBytes = whole.bytes - 500
    const text = memoryIndex(PAGES, { root: "", maxBytes }).text
    const added = memoryIndex([...PAGES, page("daily/page-30.md")], { root: "", maxBytes })
    const removed = memoryIndex(
      PAGES.filter((record) => record.resource.path !== "daily/page-0.md"),
      { root: "", maxBytes }
    )
    expect(added.text).toBe(text)
    expect(removed.text).toBe(text)
    expect(added.folded).toEqual([{ folder: "daily", pages: 31 }])
  })

  it("cuts each summary line to 120 characters", () => {
    const long = page("notes/long.md", `${"word ".repeat(80)}end.`)
    const [line] = memoryIndex([long], { root: "", maxBytes: 1_000_000 }).lines
    expect(line?.summary?.length).toBeLessThanOrEqual(120)
    expect(line?.summary?.length).toBeGreaterThan(100)
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
