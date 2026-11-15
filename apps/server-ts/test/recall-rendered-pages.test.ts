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
      sentElsewhere: new Set()
    }),
    lastChanged: new Map()
  })
    .render(new Map())
    .recall?.(room)
  const text = recall?.text ?? ""
  const sources = recall?.sources ?? []
  expect(bytes(text)).toBeLessThanOrEqual(room)
  expect(sources.map((source) => [source.page_id, source.outcome, source.reason])).toEqual([
    ["id:projects/kitchen.md", "cut", "recall_allowance"],
    ["id:projects/garden.md", "whole", null]
  ])
  const blocks = text.split(/\n\n(?=### )/u).slice(1)
  expect(blocks.map((block) => bytes(block.replace(/\n*$/u, "")))).toEqual(
    sources.map((source) => source.bytes)
  )
})
