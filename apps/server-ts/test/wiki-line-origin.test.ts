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
import { partialService } from "./kit.js"
import type { SessionQueries } from "../src/persistence/sessions/queries.js"
import { loadSnapshot } from "../src/tools/wiki.js"
import { lineOriginOutput } from "../src/tools/wiki-line-origin.js"
import { makeWikiHistoryMethods } from "../src/wiki/history.js"

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

it("stops tracing a line at the search bound and says so", async () => {
  await withWikiRepository(async ({ repository, wiki, save }) => {
    for (let edit = 0; edit <= 3; edit += 1)
      await save({ pageId: PAGE, path: PATH, body: `Oldest line.\nEdit ${edit}\n`, origin: ownerEdit })
    const bounded = makeWikiHistoryMethods(repository, () => Effect.die("unused"), {
      searchCommits: 3
    })
    const origin = await Effect.runPromise(bounded.lineOrigin(PAGE, "Oldest line"))
    expect(origin).toEqual({ kind: "older", searched: 3 })
    const record = (await loadSnapshot(wiki, new AbortController().signal)).pages.find(
      (page) => page.resource.path === PATH
    )
    if (record === undefined) throw new Error("expected the page")
    const answer = await lineOriginOutput(
      {
        wiki: { ...wiki, lineOrigin: bounded.lineOrigin },
        sessions: partialService<SessionQueries["Service"]>("SessionQueries", {})
      },
      record,
      "Oldest line",
      new AbortController().signal
    )
    expect(answer.result).toContain("newest 3 saved changes")
  })
})
