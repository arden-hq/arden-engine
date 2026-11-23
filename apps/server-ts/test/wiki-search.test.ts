import { Effect } from "effect"
import { expect, it } from "vitest"
import { searchPages } from "../src/tools/wiki-search.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { runPage } from "./kit.js"

const HASH = "0".repeat(64)
const page = (path: string, body: string) => {
  const pageId = `id:${path}`
  const text = formatWikiPage({
    pageId,
    title: path,
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
const pages = [
  page("rl.md", "Refresh plan. Start with a baseline diagnostic. Later implement PPO on CartPole."),
  page("dex.md", "The last day was July 17, 2026.")
]

it("finds a page by its words, by meaning alone, and nothing when no word matches", () => {
  const paths = (query: string, semantic: Parameters<typeof searchPages>[3] = []) =>
    searchPages(pages, query, 8, semantic).map((match) => match.record.resource.path)
  expect(paths("PPO CartPole diagnostic refresh")).toEqual(["rl.md"])
  expect(paths("zzzz qqqq", [{ pageId: "id:dex.md", score: 0.8, chunkText: "last day" }])).toEqual([
    "dex.md"
  ])
  expect(paths("zzzz qqqq")).toEqual([])
})
