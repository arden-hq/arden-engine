import { MODEL_PROVIDER_PROTOCOL } from "@arden-hq/loop"
import { chatDecoders, chatRequests, chatRoutes } from "@arden-hq/protocol/chat"
import { runDecoders, runRoutes } from "@arden-hq/protocol/runs"
import type { ModelProvider, ModelProviderRequest, Toolset } from "@arden-hq/loop"
import { SemanticResponseError } from "@arden-hq/loop/provider-kit"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { makeLoopChatRunner, startServer, type ServerHandle } from "../src/index.js"

const headers = { "content-type": "application/json" }

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

const toolset: Toolset = {
  entries: () => [],
  loadedNames: () => new Set(),
  load: () => undefined,
  execute: () => ({ content: "", preview: "" })
}

const startRun = async (server: ServerHandle): Promise<string> => {
  const session = (await (
    await server.fetch("/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Overflow" })
    })
  ).json()) as { readonly session_id: string }
  const receipt = chatDecoders.receipt(
    await (
      await server.fetch(chatRoutes.message, {
        method: "POST",
        headers,
        body: chatRequests.message({ sessionId: session.session_id, message: "Go on" }).body
      })
    ).json()
  )
  if (receipt.runId === null) throw new Error("Chat receipt did not include a run id")
  return receipt.runId
}

const runStatus = async (server: ServerHandle, runId: string) =>
  runDecoders.detail(await (await server.fetch(runRoutes.detail(runId))).json()).status

/** A provider that refuses its first request as too long and answers every later one. */
const overflowingOnce = () => {
  const requests: Array<ModelProviderRequest> = []
  const provider: ModelProvider = {
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    stream: (request) => {
      requests.push(request)
      if (requests.length === 1)
        throw new SemanticResponseError("input exceeds the window", "context_length_exceeded")
      return [
        {
          _tag: "Completed",
          message: {
            role: "assistant",
            content: "Done.",
            tool_calls: null,
            reasoning_content: null
          },
          finish_reason: "stop",
          usage: { prompt_tokens: 2, completion_tokens: 1 },
          model: request.model
        }
      ]
    }
  }
  return { requests, provider }
}

it(
  "a request refused as too long is compacted with overflow set and sent again",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-overflow-"))
    const model = overflowingOnce()
    const overflowAsked: Array<boolean> = []
    let server: ServerHandle | undefined
    try {
      server = await startServer({
        port: 0,
        databasePath: join(directory, "arden.db"),
        modelHost,
        runner: makeLoopChatRunner({
          provider: model.provider,
          toolset,
          compact: async (input) => {
            overflowAsked.push(input.overflow)
            return input.overflow
              ? {
                  kind: "replacement",
                  messages: input.messages.filter((message) => message.role !== "system")
                }
              : { kind: "unchanged" }
          }
        })
      })
      const runId = await startRun(server)
      await expect
        .poll(() => runStatus(present(server), runId), { timeout: 8_000 })
        .toBe("completed")
      expect(overflowAsked).toEqual([false, true])
      expect(model.requests).toHaveLength(2)
    } finally {
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it(
  "a request refused as too long fails the run when nothing can be compacted",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-overflow-"))
    const model = overflowingOnce()
    let server: ServerHandle | undefined
    try {
      server = await startServer({
        port: 0,
        databasePath: join(directory, "arden.db"),
        modelHost,
        runner: makeLoopChatRunner({
          provider: model.provider,
          toolset,
          compact: async () => ({ kind: "unchanged" })
        })
      })
      const runId = await startRun(server)
      await expect.poll(() => runStatus(present(server), runId), { timeout: 8_000 }).toBe("error")
      expect(model.requests).toHaveLength(1)
    } finally {
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const present = (server: ServerHandle | undefined): ServerHandle => {
  if (server === undefined) throw new Error("the server is not running")
  return server
}
