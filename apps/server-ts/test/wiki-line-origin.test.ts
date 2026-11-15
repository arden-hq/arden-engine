import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  agentChat,
  captureChat,
  namedTool,
  ownerEdit,
  resultText,
  toolContext,
  wikiToolsOver,
  withWikiRepository
} from "./fixtures/wiki-repository.js"

const PATH = "topics/note.md"
const PAGE = "note"

describe("where a line came from", () => {
  const build = async (save: Parameters<Parameters<typeof withWikiRepository>[0]>[0]["save"]) => {
    await save({
      pageId: PAGE,
      path: PATH,
      body: "Alpha fact stays.\n",
      origin: agentChat("first")
    })
    await save({
      pageId: PAGE,
      path: PATH,
      body: "Alpha fact stays.\nBeta fact from a later chat.\n",
      origin: captureChat("second"),
      actor: "memory:capture"
    })
    await save({
      pageId: PAGE,
      path: PATH,
      body: "Alpha fact stays.\nBeta fact from a later chat.\nGamma typed by the owner.\n",
      origin: ownerEdit,
      actor: "user"
    })
  }

  it("names the change that added each line, as a function over the history", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await build(save)
      const history = await Effect.runPromise(wiki.history(PAGE))
      const [third, second, first] = history.commits
      if (first === undefined || second === undefined || third === undefined)
        throw new Error("expected three commits")
      const origin = (text: string) => Effect.runPromise(wiki.lineOrigin(PAGE, text))
      expect(await origin("Alpha fact")).toMatchObject({
        kind: "added",
        line: "Alpha fact stays.",
        timestamp: first.timestamp,
        origin: { kind: "agent", sessionId: "first" }
      })
      expect(await origin("  Beta fact  ")).toMatchObject({
        kind: "added",
        timestamp: second.timestamp,
        actor: "memory:capture",
        origin: { kind: "capture", sessionId: "second" }
      })
      expect(await origin("Gamma")).toMatchObject({
        kind: "added",
        timestamp: third.timestamp,
        origin: { kind: "user" }
      })
      expect(await origin("fact")).toEqual({ kind: "ambiguous", lines: 2 })
      expect(await origin("Delta")).toEqual({ kind: "absent" })
    })
  })

  it("names the latest change that put a removed line back", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await build(save)
      await save({
        pageId: PAGE,
        path: PATH,
        body: "Beta fact from a later chat.\n",
        origin: ownerEdit
      })
      await save({
        pageId: PAGE,
        path: PATH,
        body: "Beta fact from a later chat.\nAlpha fact stays.\n",
        origin: agentChat("third")
      })
      const result = await Effect.runPromise(wiki.lineOrigin(PAGE, "Alpha fact"))
      expect(result).toMatchObject({ kind: "added", origin: { kind: "agent", sessionId: "third" } })
    })
  })

  it("answers through wiki_page_history with the writer, the time and a chat link", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await build(save)
      const tools = wikiToolsOver(wiki)
      const history = namedTool(tools, "wiki_page_history")
      const beta = resultText(
        await history.execute({ path: PATH, line: "Beta fact" }, toolContext())
      )
      expect(beta).toContain("memory:capture")
      expect(beta).toContain("arden:session/chat~second")
      await expect(history.execute({ path: PATH, line: "fact" }, toolContext())).rejects.toThrow(
        /2 lines/u
      )
      await expect(history.execute({ path: PATH, line: "Delta" }, toolContext())).rejects.toThrow(
        /not on/u
      )
    })
  })

  it("says so when the chat that wrote a line no longer exists", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await save({
        pageId: PAGE,
        path: PATH,
        body: "Alpha fact stays.\n",
        origin: agentChat("gone")
      })
      const text = resultText(
        await namedTool(wikiToolsOver(wiki), "wiki_page_history").execute(
          { path: PATH, line: "Alpha" },
          toolContext()
        )
      )
      expect(text).toContain("a chat that no longer exists")
    })
  })
})
