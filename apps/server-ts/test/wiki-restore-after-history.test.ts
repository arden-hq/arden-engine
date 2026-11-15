import { PauseRequested, createToolset } from "@arden-hq/loop"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { makeApprovalGate } from "../src/tools/approval-gate.js"
import {
  agentChat,
  historyTimes,
  ownerEdit,
  withWikiRepository,
  wikiToolsOver
} from "./fixtures/wiki-repository.js"
import { gatePolicy, serverRunContext } from "./kit.js"

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
