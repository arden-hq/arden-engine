import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  agentChat,
  historyTimes,
  namedTool,
  ownerEdit,
  toolContext,
  wikiToolsOver,
  withWikiRepository
} from "./fixtures/wiki-repository.js"
import { recordOf } from "./kit.js"

const PATH = "topics/note.md"
const PAGE = "note"

describe("wiki_restore_page after wiki_page_history", () => {
  it("restores a listed version with no separate read of the page", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await save({
        pageId: PAGE,
        path: PATH,
        body: "First version line.\n",
        origin: agentChat("a")
      })
      await save({
        pageId: PAGE,
        path: PATH,
        body: "Second version line.\n",
        origin: agentChat("a")
      })
      const tools = wikiToolsOver(wiki)
      const ctx = toolContext()
      const listed = await namedTool(tools, "wiki_page_history").execute({ path: PATH }, ctx)
      const [, older] = historyTimes(listed)
      if (older === undefined) throw new Error("expected two versions")
      const restored = await namedTool(tools, "wiki_restore_page").execute(
        { path: PATH, at: older },
        ctx
      )
      expect(recordOf(restored)["preview"]).toBe("Wiki page restored")
      const page = await Effect.runPromise(wiki.read(PAGE))
      expect(page.content).toContain("First version line.")
    })
  })

  it("still refuses a restore when the page changed after the listing", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await save({
        pageId: PAGE,
        path: PATH,
        body: "First version line.\n",
        origin: agentChat("a")
      })
      await save({
        pageId: PAGE,
        path: PATH,
        body: "Second version line.\n",
        origin: agentChat("a")
      })
      const tools = wikiToolsOver(wiki)
      const ctx = toolContext()
      const listed = await namedTool(tools, "wiki_page_history").execute({ path: PATH }, ctx)
      const [, older] = historyTimes(listed)
      if (older === undefined) throw new Error("expected two versions")
      await save({ pageId: PAGE, path: PATH, body: "Third version line.\n", origin: ownerEdit })
      await expect(
        namedTool(tools, "wiki_restore_page").execute({ path: PATH, at: older }, ctx)
      ).rejects.toThrow()
      const page = await Effect.runPromise(wiki.read(PAGE))
      expect(page.content).toContain("Third version line.")
    })
  })
})
