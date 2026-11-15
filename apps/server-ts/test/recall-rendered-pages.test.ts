import { Effect } from "effect"
import { expect, it } from "vitest"
import { prepareMemorySources } from "../src/memory/retrieval.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { PageRecord } from "../src/wiki/snapshot.js"

// Made-up pages; nothing here comes from anyone's Memory.

const HASH = "0".repeat(64)

const page = (path: string, title: string, body: string): PageRecord => {
  const pageId = `id:${path}`
  return {
    resource: { resourceId: pageId, path, blobId: HASH, state: "active", versionId: HASH },
    page: Effect.runSync(
      parseWikiPage(
        formatWikiPage({
          pageId,
          title,
          aliases: [],
          lifecycle: "active",
          redirectTo: null,
          metadata: {},
          body
        }),
        pageId
      )
    )
  }
}

const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).byteLength

it("recall fits its room in bytes, cuts a page whole lines at a time, and records each block", () => {
  const room = 7_000
  const recall = prepareMemorySources({
    pages: [
      page("projects/garden.md", "Garden", "The garden seeds are ordered."),
      page(
        "projects/kitchen.md",
        "Kitchen",
        "The kitchen garden plan, line by line: café, crème brûlée.\n".repeat(2_000)
      )
    ],
    recall: { query: "garden seeds kitchen plan", excludedPageIds: new Set() },
    lastChanged: new Map()
  })
    .render(new Map())
    .recall?.(room)
  const text = recall?.text ?? ""
  expect(bytes(text)).toBeLessThanOrEqual(room)
  expect(
    (recall?.sources ?? []).map((source) => [source.page_id, source.outcome, source.reason])
  ).toEqual([
    ["id:projects/kitchen.md", "cut", "recall_allowance"],
    ["id:projects/garden.md", "whole", null]
  ])
  expect(text).toContain("café, crème brûlée.\n\n[Partial page; use wiki_read_page")
  const blocks = text.split(/\n\n(?=### )/u).slice(1)
  expect(blocks.map((block) => bytes(block.replace(/\n*$/u, "")))).toEqual(
    (recall?.sources ?? []).map((source) => source.bytes)
  )
})

it("records a matched passage cut for room as cut, and names a page with no room as left out", () => {
  const pages = [
    page("projects/garden.md", "Garden", "The garden seeds are ordered."),
    page("projects/kitchen.md", "Kitchen", "The kitchen plan.")
  ]
  const render = (room: number) =>
    prepareMemorySources({
      pages,
      recall: { query: "garden seeds kitchen plan", excludedPageIds: new Set() },
      semanticMatches: [
        {
          pageId: "id:projects/kitchen.md",
          chunkText: "The kitchen plan, step by step.\n".repeat(400),
          score: 0.9
        }
      ],
      lastChanged: new Map()
    })
      .render(new Map())
      .recall?.(room)
  const roomy = render(7_000)
  expect(roomy?.sources.map((source) => [source.page_id, source.outcome, source.reason])).toEqual([
    ["id:projects/kitchen.md", "cut", "recall_allowance"],
    ["id:projects/garden.md", "whole", null]
  ])
  const whole = prepareMemorySources({
    pages,
    recall: { query: "kitchen plan", excludedPageIds: new Set() },
    semanticMatches: [
      { pageId: "id:projects/kitchen.md", chunkText: "The kitchen plan.", score: 0.9 }
    ],
    lastChanged: new Map()
  })
    .render(new Map())
    .recall?.(7_000)
  expect(whole?.sources[0]).toMatchObject({ outcome: "passage", reason: null })
  const tight = render(600)
  expect(tight?.sources.map((source) => [source.outcome, source.reason])).toContainEqual([
    "dropped",
    "recall_allowance"
  ])
  expect(tight?.text).toContain("left out for lack of room")
})
