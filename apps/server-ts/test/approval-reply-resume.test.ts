import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { ChatMessage } from "../src/chat/message.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { TerminalSessions } from "../src/terminals/service.js"
import { terminalResult } from "./fixtures/chat-result.js"
import { noModelProvider } from "./fixtures/no-model-provider.js"
import type { ToolResult } from "@arden-hq/loop"

it("resumes the last denied approval with one reason and never executes the rejected call", async () => {
  const delivered = Promise.withResolvers<{
    runId: string
    reasons: unknown[]
    repeated: unknown[]
    result: ToolResult | undefined
  }>()
  const storage = recoveredSqlitePersistenceLayer({ dataDir: null, filename: ":memory:" }).pipe(
    Layer.provide(PersistenceWriteQueue.layer)
  )
  const layer = ChatMessage.layer({
    runner: async function* (input) {
      const results = await input.tools.recover([
        {
          toolCallId: "change",
          name: "file_write",
          args: { path: "/tmp/file" },
          changesState: true
        }
      ])
      const pending = await input.getPendingMessages()
      delivered.resolve({
        runId: input.runId,
        reasons: pending.map((message) => message.content),
        repeated: [...(await input.getPendingMessages())],
        result: results.get("change")
      })
      yield terminalResult(input, "Kept the original", pending)
    }
  }).pipe(
    Layer.provide(noModelProvider),
    Layer.provide(TerminalSessions.layer),
    Layer.provideMerge(storage)
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const sender = yield* ChatMessage
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const tools = yield* ToolExecutionStore
      const session = yield* sessions.create({ name: "Approval reply resume" })
      const run = yield* chat.start({
        sessionId: session.sessionId,
        clientId: "start",
        requestHash: "start",
        assistantMessageId: "answer",
        message: {
          message_id: "start",
          client_id: "start",
          role: "user",
          content: "Work",
          created_at: new Date().toISOString()
        }
      })
      const call = {
        runId: run.runId,
        sessionId: session.sessionId,
        toolCallId: "change",
        toolName: "file_write",
        arguments: { path: "/tmp/file" },
        changesState: true
      }
      yield* tools.begin(call)
      yield* tools.pause(call, { reason: "approval", preview: "Write file" })
      const receipt = yield* sender.send({
        sessionId: session.sessionId,
        clientId: "reply",
        message: "Keep the original",
        approvalReply: { runId: run.runId, toolId: "change" }
      })
      expect(receipt.runId).toBe(run.runId)
      const observed = yield* Effect.promise(() => delivered.promise)
      expect(observed).toMatchObject({
        runId: run.runId,
        reasons: ["Keep the original"],
        repeated: [],
        result: {
          content: "The user rejected this tool execution.",
          preview: "Tool execution rejected",
          is_error: true,
          retryable: false,
          data: {
            approval: { by: "user", decision: "rejected" }
          }
        }
      })
    }).pipe(Effect.provide(layer), Effect.scoped)
  )
})
