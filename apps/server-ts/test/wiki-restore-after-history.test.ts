import { PauseRequested, createToolset } from "@arden-hq/loop"
import { type WikiPage, wikiDecoders, wikiRequests, wikiRoutes } from "@arden-hq/protocol/wiki"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { expect, it } from "vitest"

import { WikiApi } from "../src/http/wiki/api.js"
import { WikiHandlers } from "../src/http/wiki/handlers.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { SummaryStore } from "../src/persistence/summaries/store.js"
import { RULES_PAGE_PATH } from "../src/wiki/code-owned-pages.js"
import { Wiki } from "../src/wiki/service.js"

import { makeApprovalGate } from "../src/tools/approval-gate.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { OWNER_RENAME } from "../src/wiki/rename.js"
import {
  agentChat,
  historyTimes,
  ownerEdit,
  withWikiRepository,
  wikiToolsOver
} from "./fixtures/wiki-repository.js"
import { gatePolicy, partialService, serverRunContext } from "./kit.js"

const PATH = "topics/note.md"
const PAGE = "note"

it("refuses an approved restore when the page changed after the card", async () => {
  await withWikiRepository(async ({ wiki, save }) => {
    await save({ pageId: PAGE, path: PATH, body: "First version line.\n", origin: agentChat("a") })
    await save({ pageId: PAGE, path: PATH, body: "Second version line.\n", origin: agentChat("a") })
    const tools = wikiToolsOver(wiki)
    const toolset = () =>
      createToolset(tools, {
        toJsonSchema: () => ({ type: "object" }),
        approvalGate: makeApprovalGate({
          review: async () => ({ verdict: "ask", why: { kind: "judged", reason: "unused" } }),
          policy: gatePolicy("ask")
        })
      })(serverRunContext())
    const asking = toolset()
    const listed = await asking.execute({
      name: "wiki_page_history",
      args: { path: PATH },
      toolCallId: "h"
    })
    const at = historyTimes({ data: listed.data })[1]
    const card = await asking
      .execute({ name: "wiki_restore_page", args: { path: PATH, at }, toolCallId: "restore" })
      .catch((cause: unknown) => cause)
    if (!(card instanceof PauseRequested)) throw card
    await save({ pageId: PAGE, path: PATH, body: "Third version line.\n", origin: ownerEdit })
    await expect(
      toolset().execute({
        name: "wiki_restore_page",
        args: { path: PATH, at },
        toolCallId: "restore",
        approval: {
          approved: true,
          feedback: null,
          ...(card.data === undefined ? {} : { data: card.data })
        }
      })
    ).rejects.toThrow()
    expect((await Effect.runPromise(wiki.read(PAGE))).content).toContain("Third version line.")
  })
})

it("renames a page and its links in one commit, refused when Memory changed after the preview", async () => {
  await withWikiRepository(async ({ wiki, save }) => {
    const other = { pageId: "other", path: "topics/other.md", origin: agentChat("a") }
    await save({ pageId: PAGE, path: PATH, body: "Note.\n", origin: agentChat("a") })
    await save({ ...other, body: "See [[topics/note]].\n" })
    const request = async () => {
      const { version, repositoryHead } = await Effect.runPromise(wiki.read(PAGE))
      const read = { expectedVersion: version, expectedHead: repositoryHead }
      const to = { newPath: "topics/renamed.md", newTitle: "Renamed", commit: OWNER_RENAME }
      return { pageId: PAGE, ...read, ...to, authority: GLOBAL_WIKI_LOCATION_AUTHORITY }
    }
    const previewed = await request()
    const plan = await Effect.runPromise(wiki.planRename(previewed))
    expect(plan).toMatchObject({ linkCount: 1, pageCount: 1 })
    await save({ ...other, body: "See [[topics/note]] again.\n" })
    expect(await Effect.runPromise(wiki.rename(previewed).pipe(Effect.flip))).toMatchObject({
      _tag: "WikiError",
      reason: "conflict"
    })
    await Effect.runPromise(wiki.rename(await request()))
    expect((await Effect.runPromise(wiki.read(PAGE))).path).toBe("topics/renamed.md")
    expect((await Effect.runPromise(wiki.read("other"))).content).toContain("[[topics/renamed]]")
  })
})

it("the owner restores a chosen version of any page over the route, refused once stale", async () => {
  await withWikiRepository(async ({ wiki, save }) => {
    await save({ pageId: PAGE, path: PATH, body: "First version line.\n", origin: agentChat("a") })
    await Effect.runPromise(wiki.createRulesPage("First version line.\n"))
    const services = Layer.mergeAll(
      Layer.succeed(Wiki, wiki),
      ...[SessionQueries, SpaceStore, SummaryStore].map((tag) =>
        Layer.succeed(tag, partialService(tag.key, {}))
      )
    )
    const app = HttpApiBuilder.layer(HttpApi.make("arden-server").add(WikiApi)).pipe(
      Layer.provide(WikiHandlers.pipe(Layer.provide(services))),
      Layer.provide(HttpServer.layerServices)
    )
    const { handler } = HttpRouter.toWebHandler(app, { disableLogger: true })
    const call = async (method: string, route: string, body?: string) => {
      const init = { method, body: body ?? null, headers: { "content-type": "application/json" } }
      const response = await handler(new Request(`http://localhost${route}`, init))
      return { status: response.status, body: await response.json() }
    }
    const { pages } = await Effect.runPromise(wiki.list({}))
    for (const pageId of [
      PAGE,
      pages.find((page) => page.path === RULES_PAGE_PATH)?.pageId ?? ""
    ]) {
      const first = await Effect.runPromise(wiki.read(pageId))
      const edit = wikiRequests.update(first, first.content.replace("First", "Second"))
      const second = wikiDecoders.page((await call("PUT", wikiRoutes.page(pageId), edit)).body)
      const history = (await call("GET", wikiRoutes.history(pageId))).body
      const commits = wikiDecoders.history(history).commits
      expect(commits.map((commit) => commit.restorable)).toEqual([[], ["after"]])
      const restore = (page: WikiPage) =>
        call(
          "POST",
          wikiRoutes.historyRestore(pageId, commits[1]?.commitId ?? ""),
          wikiRequests.restoreHistory(page, "after")
        )
      const stale = await restore(first)
      expect([stale.status, stale.body.detail.error]).toEqual([409, "page_revision_conflict"])
      expect(wikiDecoders.page((await restore(second)).body).content).toContain("First version")
    }
  })
})
