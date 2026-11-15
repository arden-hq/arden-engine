import { createToolset, type Toolset, type ToolResult } from "@arden-hq/loop"
import { Effect, Semaphore } from "effect"
import { expect, it } from "vitest"

import { makeDurableTools, type ToolHost } from "../src/chat/durable-tools.js"
import { makeHeldBackground } from "../src/chat/held-background.js"
import type { ChatRunnerToolRequest } from "../src/chat/runner-contract.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { RecordedToolPause } from "../src/execution/recorded-tool-pause.js"
import { makeApprovalGate } from "../src/tools/approval-gate.js"
import type { ServerTool } from "../src/tools/define.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import {
  agentChat,
  historyTimes,
  withWikiRepository,
  wikiToolsOver
} from "./fixtures/wiki-repository.js"
import { gatePolicy, recordOf, serverRunContext } from "./kit.js"

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

const host: ToolHost = {
  lifecycle: Semaphore.makeUnsafe(1),
  launch: () => Effect.die("no resume launch in this test"),
  cancelAgent: () => Effect.die("no agents in this test"),
  sendMessage: () => Effect.die("no messages in this test"),
  detachedRun: () => Effect.die("no detached runs in this test"),
  draining: () => false,
  heldBackground: makeHeldBackground()
}

it("restores after approval through a stored card, with the reads the asking run had made", async () => {
  await withWikiRepository(async ({ wiki, save }) => {
    await save({ pageId: PAGE, path: PATH, body: "First version line.\n", origin: agentChat("a") })
    await save({ pageId: PAGE, path: PATH, body: "Second version line.\n", origin: agentChat("a") })
    const tools = wikiToolsOver(wiki)
    const asking = serverRunContext()
    const listed = await toolsetOf(tools, asking).execute({
      name: "wiki_page_history",
      args: { path: PATH },
      toolCallId: "history"
    })
    const [, older] = historyTimes({ data: listed.data })
    if (older === undefined) throw new Error("expected two versions")
    const request: ChatRunnerToolRequest = {
      toolCallId: "restore",
      name: "wiki_restore_page",
      args: { path: PATH, at: older },
      changesState: true
    }
    const outcome = await withTempDatabase(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const chat = yield* ChatWriteStore
        const toolStore = yield* ToolExecutionStore
        const session = yield* sessions.create({ name: "Restore after approval" })
        const run = yield* chat.start({
          sessionId: session.sessionId,
          clientId: "start",
          requestHash: "start",
          assistantMessageId: "answer",
          message: {
            message_id: "start",
            client_id: "start",
            role: "user",
            content: "Bring the note back",
            created_at: new Date().toISOString()
          }
        })
        const durable = makeDurableTools(host, {
          sessionId: session.sessionId,
          runId: run.runId,
          signal: new AbortController().signal,
          eventSequence: { value: undefined }
        })
        const execute = (runContext: ServerRunContext) =>
          Effect.flatMap(durable, (durableTools) =>
            Effect.promise(() =>
              durableTools
                .execute(request, (context) =>
                  toolsetOf(tools, runContext).execute({
                    name: request.name,
                    args: request.args,
                    toolCallId: request.toolCallId,
                    ...(context?.approval === undefined ? {} : { approval: context.approval })
                  })
                )
                .then(
                  (result): ToolResult | unknown => result,
                  (cause: unknown) => cause
                )
            )
          )
        const paused = yield* execute(asking)
        yield* toolStore.resolve({ runId: run.runId, toolCallId: "restore", approved: true })
        const resumed = yield* execute(serverRunContext())
        return { paused, resumed }
      })
    )
    expect(outcome.paused).toBeInstanceOf(RecordedToolPause)
    expect(recordOf(recordOf(outcome.resumed)["data"])["changed"]).toBe(true)
    const page = await Effect.runPromise(wiki.read(PAGE))
    expect(page.content).toContain("First version line.")
  })
})
