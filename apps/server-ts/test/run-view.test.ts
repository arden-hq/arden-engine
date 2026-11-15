import { Effect } from "effect"
import { expect, it } from "vitest"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { snapshotOf, type PageRecord } from "../src/wiki/snapshot.js"
const HASH = "0".repeat(64)
const page = (path: string): PageRecord => {
  const pageId = `id:${path}`
  const text = formatWikiPage({
    pageId,
    title: path,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body: "x"
  })
  return {
    resource: { resourceId: pageId, path, blobId: HASH, state: "active", versionId: HASH },
    page: Effect.runSync(parseWikiPage(text, pageId))
  }
}
it("shows a run every page but the code-owned ones, and keeps the whole set apart", () => {
  const snapshot = snapshotOf("head", [page("forgotten.md"), page("topics/garden.md")])
  expect(snapshot.pages.map((record) => record.resource.path)).toEqual(["topics/garden.md"])
  expect(snapshot.wholeSet).toHaveLength(2)
})
