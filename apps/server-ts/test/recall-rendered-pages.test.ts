import { Effect } from "effect"
import { expect, it } from "vitest"
import { prepareMemoryRecall } from "../src/memory/retrieval.js"
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

it("recall names each page block exactly as the text holds it, and whether it is whole", () => {
  const recall = prepareMemoryRecall({
    pages: [
      page("projects/garden.md", "Garden", "The garden seeds are ordered."),
      page(
        "projects/kitchen.md",
        "Kitchen",
        "The kitchen garden plan, line by line.\n".repeat(2_000)
      )
    ],
    query: "garden seeds kitchen plan",
    lastChanged: new Map()
  }).render(new Map())
  expect(
    recall.sources
      .map(({ path, placement }) => ({ path, shown: placement.shown }))
      .toSorted((a, b) => a.path.localeCompare(b.path))
  ).toEqual([
    { path: "projects/garden.md", shown: "whole" },
    { path: "projects/kitchen.md", shown: "cut" }
  ])
  for (const { placement } of recall.sources)
    if (placement.shown !== "dropped") expect(recall.text).toContain(placement.block)
})
