import { Effect } from "effect"
import { expect, it } from "vitest"
import { prepareMemorySources, recallCandidates } from "../src/memory/retrieval.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { runPage } from "./kit.js"

const HASH = "0".repeat(64)
const page = (path: string, title: string, body: string) => {
  const pageId = `id:${path}`
  const text = formatWikiPage({
    pageId,
    title,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body
  })
  return runPage({
    resource: { resourceId: pageId, path, blobId: HASH, state: "active", versionId: HASH },
    page: Effect.runSync(parseWikiPage(text, pageId))
  })
}
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength

it("recall fits its room in bytes, cuts a long page, and records each block's bytes", () => {
  const room = 7_000
  const pages = [
    page("projects/garden.md", "Garden", "The garden seeds are ordered."),
    page(
      "projects/kitchen.md",
      "Kitchen",
      "The kitchen garden plan, café, crème brûlée.\n".repeat(2_000)
    )
  ]
  const recall = prepareMemorySources({
    pages,
    recall: recallCandidates({
      pages,
      query: "garden seeds kitchen plan",
      today: "2026-11-14",
      sent: new Map()
    }),
    lastChanged: new Map()
  })
    .render(new Map())
    .recall?.(room)
  const text = recall?.text ?? ""
  const sources = recall?.sources ?? []
  expect(bytes(text)).toBeLessThanOrEqual(room)
  expect(sources).toMatchObject([
    { page_id: "id:projects/kitchen.md", outcome: "cut", reason: "recall_allowance" },
    { page_id: "id:projects/garden.md", outcome: "whole" }
  ])
  expect(sources[1]).not.toHaveProperty("reason")
  const blocks = text.split(/\n\n(?=### )/u).slice(1)
  expect(blocks.map((block) => bytes(block.replace(/\n*$/u, "")))).toEqual(
    sources.map((source) => source.bytes)
  )
})

it("recall stays within its room when an earlier block is short and a later page is long", () => {
  const room = 7_000
  const pages = [
    page("projects/garden.md", "Garden", "The garden seeds are ordered. ".repeat(80)),
    page("projects/kitchen.md", "Kitchen", "The kitchen plan, café, crème brûlée.\n".repeat(2_000))
  ]
  const recall = prepareMemorySources({
    pages,
    recall: recallCandidates({
      pages,
      query: "garden seeds ordered kitchen",
      today: "2026-11-14",
      sent: new Map()
    }),
    lastChanged: new Map()
  })
    .render(new Map())
    .recall?.(room)
  expect(recall?.sources).toHaveLength(2)
  expect(bytes(recall?.text ?? "")).toBeLessThanOrEqual(room)
})

it("recall of a page the run holds in part offers only the text past what it holds", () => {
  const head = "Seeds are ordered for the garden.\n".repeat(10)
  const space = page(
    "spaces/garden.md",
    "Garden",
    `${head}The greenhouse key is under the blue pot.`
  )
  const held = space.page.content.length - space.page.body.length + head.length
  const recallOf = (query: string) =>
    prepareMemorySources({
      pages: [space],
      recall: recallCandidates({
        pages: [space],
        query,
        today: "2026-11-14",
        sent: new Map([[space.page.pageId, held]])
      }),
      lastChanged: new Map()
    })
      .render(new Map())
      .recall?.(7_000).text ?? ""
  expect(recallOf("where is the greenhouse key")).toContain("under the blue pot")
  expect(recallOf("where is the greenhouse key")).not.toContain("Seeds are ordered")
  expect(recallOf("which seeds were ordered for my garden")).toBe("")
})
