import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { searchPages } from "../src/tools/wiki-search.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { RunPage } from "../src/wiki/snapshot.js"
import { runPage } from "./kit.js"

const HASH = "0".repeat(64)

const page = (path: string, title: string, body: string): RunPage => {
  const pageId = `id:${path}`
  return runPage({
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
  })
}

const pages = [
  page(
    "areas/reinforcement-learning.md",
    "Reinforcement Learning",
    "Refresh plan. Start with a baseline diagnostic. Later implement PPO on CartPole."
  ),
  page("projects/dex.md", "Dex", "Historical work. The last day was July 17, 2026."),
  page("areas/health.md", "Health", "Sleep and training notes. A diagnostic was booked.")
]

const found = (query: string, semantic: Parameters<typeof searchPages>[3] = []) =>
  searchPages(pages, query, 8, semantic).map((match) => match.record.resource.path)

describe("wiki_search", () => {
  it("finds a page by its words when the query is not an exact phrase in it", () => {
    expect(found("PPO CartPole diagnostic refresh")).toEqual([
      "areas/reinforcement-learning.md",
      "areas/health.md"
    ])
  })

  it("puts the page that holds the query as written first", () => {
    expect(found("July 17")).toEqual(["projects/dex.md"])
    expect(found("dex")[0]).toBe("projects/dex.md")
  })

  it("returns a page found only by meaning, and shows the passage that matched", () => {
    const matches = searchPages(pages, "when did the job end", 8, [
      { pageId: "id:projects/dex.md", score: 0.8, chunkText: "The last day was July 17, 2026." }
    ])
    expect(
      matches.map((match) => ({ path: match.record.resource.path, snippet: match.snippet }))
    ).toContainEqual({ path: "projects/dex.md", snippet: "The last day was July 17, 2026." })
  })

  it("returns nothing when no page shares a word with the query", () => {
    expect(found("zzzz qqqq")).toEqual([])
  })
})
