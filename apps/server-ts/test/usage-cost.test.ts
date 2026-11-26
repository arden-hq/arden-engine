import { messageInput, receiptRunId } from "./fixtures/chat-requests.js"
import { newChat } from "./fixtures/new-chat.js"
import { MODEL_PROVIDER_PROTOCOL } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ModelProvider, Toolset } from "@arden-hq/loop"
import { chatDecoders, chatRequests, chatRoutes } from "@arden-hq/protocol/chat"
import { runDecoders, runRoutes } from "@arden-hq/protocol/runs"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { makeLoopChatRunner, startServer, type ServerHandle } from "../src/index.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { UsageStore } from "../src/persistence/usage/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"

const tokens = (prompt: number) => ({
  prompt,
  completion: 2,
  cache_read: 0,
  cache_write: 0,
  total: prompt + 2
})

it("keeps the cost providers report beside usage, and leaves a total unknown when one call reported none", async () => {
  const storage = recoveredSqlitePersistenceLayer({ dataDir: null, filename: ":memory:" }).pipe(
    Layer.provide(PersistenceWriteQueue.layer)
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const usage = yield* UsageStore
      const startRun = Effect.fn(function* (name: string) {
        const session = yield* sessions.create({ name })
        const run = yield* chat.start({
          sessionId: session.sessionId,
          clientId: `${name}-start`,
          requestHash: `${name}-start`,
          assistantMessageId: `${name}-answer`,
          message: {
            message_id: `${name}-start`,
            client_id: `${name}-start`,
            role: ROLE.user,
            content: "Work",
            created_at: new Date().toISOString()
          }
        })
        return { sessionId: session.sessionId, runId: run.runId }
      })

      const priced = yield* startRun("priced")
      yield* chat.recordModelUsage({
        runId: priced.runId,
        sampleId: "a",
        usage: { ...tokens(10), cost: 0.0004 }
      })
      yield* chat.recordModelUsage({
        runId: priced.runId,
        sampleId: "b",
        usage: { ...tokens(20), cost: 0.0001 }
      })
      yield* usage.recordModelCall({
        kind: "chat_title",
        owner: { type: "session", sessionId: priced.sessionId },
        modelId: "openai/gpt-6-luna",
        usage: { ...tokens(5), cost: 0.00002 }
      })
      const pricedCalls = yield* usage.sessionUsage({ sessionId: priced.sessionId, limit: 5 })
      expect(pricedCalls.runs[0]?.calls.map((call) => call.usage?.cost)).toEqual([0.0004, 0.0001])
      const first = yield* usage.report({ days: 1 })
      expect(first.daily.map((cell) => [cell.kind, cell.total, cell.cost]).sort()).toEqual([
        ["chat", 34, 0.0005],
        ["chat_title", 7, 0.00002]
      ])
      expect(first.top_sessions.map((row) => row.cost)).toEqual([0.0005])

      const unpriced = yield* startRun("unpriced")
      yield* chat.recordModelUsage({ runId: unpriced.runId, sampleId: "c", usage: tokens(30) })
      yield* usage.recordModelCall({
        kind: "chat_title",
        owner: { type: "session", sessionId: unpriced.sessionId },
        modelId: "openai/gpt-6-luna",
        usage: tokens(5)
      })
      const second = yield* usage.report({ days: 1 })
      expect(second.daily.map((cell) => [cell.kind, cell.total, "cost" in cell]).sort()).toEqual([
        ["chat", 66, false],
        ["chat_title", 14, false]
      ])
      expect(
        second.top_sessions.map((row) => [row.session_id === priced.sessionId, row.cost]).sort()
      ).toEqual([
        [false, undefined],
        [true, 0.0005]
      ])
    }).pipe(Effect.provide(storage))
  )
})

const modelHost = {
  models: [
    {
      id: "fixture-model",
      name: "Fixture model",
      provider: { id: "fixture", name: "Fixture" },
      reasoningEfforts: [],
      context: { hardLimit: 128_000, compactionTrigger: 100_000 }
    }
  ],
  defaults: {
    chatModelId: "fixture-model",
    reasoningEfforts: {},
    roles: {
      background: { modelId: null, reasoningEffort: null },
      helper: { modelId: null, reasoningEffort: null }
    }
  }
} as const

const noTools: Toolset = {
  entries: () => [],
  loadedNames: () => new Set(),
  load: () => undefined,
  execute: () => ({ content: "", preview: "" })
}

const answering = (cost: number | undefined): ModelProvider => ({
  protocolVersion: MODEL_PROVIDER_PROTOCOL,
  stream: (request) => [
    {
      _tag: "Completed",
      message: {
        role: ROLE.assistant,
        content: "Done.",
        tool_calls: null,
        reasoning_content: null
      },
      finish_reason: "stop",
      usage: { prompt_tokens: 2, completion_tokens: 1, ...(cost === undefined ? {} : { cost }) },
      model: request.model
    }
  ]
})

const finishedResult = async (cost: number | undefined) => {
  const directory = await mkdtemp(join(tmpdir(), "arden-cost-"))
  let server: ServerHandle | undefined
  try {
    const running = await startServer({
      port: 0,
      databasePath: join(directory, "arden.db"),
      modelHost,
      runner: makeLoopChatRunner({ provider: answering(cost), toolset: noTools })
    })
    server = running
    const session = (await (
      await running.fetch("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(newChat({ name: "Cost" }))
      })
    ).json()) as { readonly session_id: string }
    const receipt = chatDecoders.receipt(
      await (
        await running.fetch(chatRoutes.message, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: chatRequests.message(messageInput(session.session_id, "Go")).body
        })
      ).json()
    )
    const runId = receiptRunId(receipt)
    const detail = async () =>
      runDecoders.detail(await (await running.fetch(runRoutes.detail(runId))).json())
    await expect.poll(async () => (await detail()).status, { timeout: 8_000 }).toBe("completed")
    const ended = await detail()
    if (!("result" in ended) || ended.result.kind === "none") throw new Error("Run had no result")
    return ended.result.result
  } finally {
    await server?.stop().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}

it(
  "puts the provider's reported cost on a Run's result, and none when it reported none",
  { timeout: 20_000 },
  async () => {
    const priced = await finishedResult(0.0003)
    expect(priced.usage).toEqual({
      prompt: 2,
      completion: 1,
      total: 3,
      cache_read: 0,
      cache_write: 0,
      cost: { kind: "reported", usd: 0.0003 }
    })
    const unpriced = await finishedResult(undefined)
    expect(unpriced.usage).toEqual({
      prompt: 2,
      completion: 1,
      total: 3,
      cache_read: 0,
      cache_write: 0,
      cost: { kind: "unreported" }
    })
  }
)
