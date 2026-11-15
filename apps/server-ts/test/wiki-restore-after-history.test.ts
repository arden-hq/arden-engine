import { PauseRequested, createToolset, type Toolset } from "@arden-hq/loop"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { makeApprovalGate } from "../src/tools/approval-gate.js"
import type { ServerTool } from "../src/tools/define.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import type { Wiki } from "../src/wiki/service.js"
import {
  agentChat,
  historyTimes,
  ownerEdit,
  withWikiRepository,
  wikiToolsOver,
  type WikiRepositoryFixture
} from "./fixtures/wiki-repository.js"
import { gatePolicy, recordOf, serverRunContext } from "./kit.js"

// The owner asks to bring back an older version of a page. The chat lists the page's history,
// the owner approves a card that shows what changes, and the approved call runs later in a new
// toolset (a resumed run, or a card's follow-up).

const PATH = "topics/note.md"
const PAGE = "note"

const toolsetOf = (tools: ReadonlyArray<ServerTool>, run: ServerRunContext): Toolset =>
  createToolset(tools, {
    toJsonSchema: () => ({ type: "object" }),
    approvalGate: makeApprovalGate({
      review: async () => ({ verdict: "ask", why: { kind: "judged", reason: "unused" } }),
      policy: gatePolicy("ask")
    })
  })(run)

const twoVersions = async (save: WikiRepositoryFixture["save"]): Promise<void> => {
  await save({ pageId: PAGE, path: PATH, body: "First version line.\n", origin: agentChat("a") })
  await save({ pageId: PAGE, path: PATH, body: "Second version line.\n", origin: agentChat("a") })
}

const olderTime = async (toolset: Toolset): Promise<string> => {
  const listed = await toolset.execute({
    name: "wiki_page_history",
    args: { path: PATH },
    toolCallId: "history"
  })
  const [, older] = historyTimes({ data: listed.data })
  if (older === undefined) throw new Error("expected two versions")
  return older
}

const askRestore = async (toolset: Toolset, at: string): Promise<unknown> =>
  toolset
    .execute({ name: "wiki_restore_page", args: { path: PATH, at }, toolCallId: "restore" })
    .then(
      () => new Error("expected an approval card"),
      (cause: unknown) => cause
    )

const pageText = (wiki: Wiki["Service"]) =>
  Effect.runPromise(wiki.read(PAGE)).then((page) => page.content)

describe("wiki_restore_page after wiki_page_history", () => {
  it("shows the change on its card and runs once approved in a new toolset", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await twoVersions(save)
      const tools = wikiToolsOver(wiki)
      const asking = toolsetOf(tools, serverRunContext())
      const card = await askRestore(asking, await olderTime(asking))
      if (!(card instanceof PauseRequested)) throw card
      expect(card.diff).toContain("+First version line.")
      expect(card.diff).toContain("-Second version line.")
      const approved = await toolsetOf(tools, serverRunContext()).execute({
        name: "wiki_restore_page",
        args: { path: PATH, at: await olderTime(asking) },
        toolCallId: "restore",
        approval: {
          approved: true,
          feedback: null,
          ...(card.data === undefined ? {} : { data: card.data })
        }
      })
      expect(recordOf(approved.data)["changed"]).toBe(true)
      expect(await pageText(wiki)).toContain("First version line.")
    })
  })

  it("refuses an approved restore when the page changed after the card", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await twoVersions(save)
      const tools = wikiToolsOver(wiki)
      const asking = toolsetOf(tools, serverRunContext())
      const older = await olderTime(asking)
      const card = await askRestore(asking, older)
      if (!(card instanceof PauseRequested)) throw card
      await save({ pageId: PAGE, path: PATH, body: "Third version line.\n", origin: ownerEdit })
      await expect(
        toolsetOf(tools, serverRunContext()).execute({
          name: "wiki_restore_page",
          args: { path: PATH, at: older },
          toolCallId: "restore",
          approval: {
            approved: true,
            feedback: null,
            ...(card.data === undefined ? {} : { data: card.data })
          }
        })
      ).rejects.toThrow()
      expect(await pageText(wiki)).toContain("Third version line.")
    })
  })

  it("keeps a version the run read earlier, so a change it has not seen refuses the card", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await twoVersions(save)
      const tools = wikiToolsOver(wiki)
      const run = serverRunContext()
      const read = await Effect.runPromise(wiki.read(PAGE))
      run.observations.observe(read.pageId, read.version)
      const asking = toolsetOf(tools, run)
      await save({ pageId: PAGE, path: PATH, body: "Third version line.\n", origin: ownerEdit })
      const card = await askRestore(asking, await olderTime(asking))
      expect(card).not.toBeInstanceOf(PauseRequested)
      expect(String(card)).toContain("changed after this run read it")
    })
  })

  it("does not count a line lookup as having seen the page", async () => {
    await withWikiRepository(async ({ wiki, save }) => {
      await twoVersions(save)
      const tools = wikiToolsOver(wiki)
      const lister = toolsetOf(tools, serverRunContext())
      const older = await olderTime(lister)
      const asking = toolsetOf(tools, serverRunContext())
      await asking.execute({
        name: "wiki_page_history",
        args: { path: PATH, line: "Second version line." },
        toolCallId: "line"
      })
      const card = await askRestore(asking, older)
      expect(card).not.toBeInstanceOf(PauseRequested)
      expect(String(card)).toContain(`Read ${PATH} before changing it`)
    })
  })
})
