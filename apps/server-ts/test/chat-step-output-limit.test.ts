import { MODEL_PROVIDER_PROTOCOL } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { chatDecoders, chatRequests, chatRoutes } from "@arden-hq/protocol/chat"
import { runDecoders, runRoutes } from "@arden-hq/protocol/runs"
import type { ModelCapabilities, ModelProvider, ModelProviderRequest } from "@arden-hq/loop"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { startServer, type ServerHandle } from "../src/index.js"
import type { ModelHost } from "../src/models/host.js"

const headers = { "content-type": "application/json" }

const host = (outputCap?: number): ModelHost => ({
  models: [
    {
      id: "m",
      name: "m",
      provider: { id: "p", name: "P" },
      reasoningEfforts: [],
      context: {
        hardLimit: 32_768,
        compactionTrigger: 26_214,
        ...(outputCap === undefined ? {} : { outputCap })
      }
    }
  ],
  defaults: {
    chatModelId: "m",
    reasoningEfforts: {},
    roles: {
      background: { modelId: null, reasoningEffort: null },
      helper: { modelId: null, reasoningEffort: null }
    }
  }
})

const recording = (outputLimit: ModelCapabilities["outputLimit"] = undefined) => {
  const requests: Array<ModelProviderRequest> = []
  const provider: ModelProvider = {
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    capabilities: () => ({
      hostedTools: [],
      structuredOutput: "native",
      ...(outputLimit === undefined ? {} : { outputLimit })
    }),
    stream: (request) => {
      requests.push(request)
      return [
        {
          _tag: "Completed",
          message: {
            role: ROLE.assistant,
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

const chatTurn = async (provider: ModelProvider, modelHost: ModelHost): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-step-limit-"))
  let server: ServerHandle | undefined
  try {
    server = await startServer({
      port: 0,
      databasePath: join(directory, "arden.db"),
      provider,
      modelHost,
      sharedSkillRoots: [],
      memory: false,
      idleCompactionAfterMs: 0
    })
    const running = server
    const session = (await (
      await running.fetch("/sessions", { method: "POST", headers, body: JSON.stringify({}) })
    ).json()) as { readonly session_id: string }
    const receipt = chatDecoders.receipt(
      await (
        await running.fetch(chatRoutes.message, {
          method: "POST",
          headers,
          body: chatRequests.message({ sessionId: session.session_id, message: "Hi" }).body
        })
      ).json()
    )
    const runId = receipt.runId
    if (runId === null) throw new Error("Chat receipt did not include a run id")
    await expect
      .poll(
        async () =>
          runDecoders.detail(await (await running.fetch(runRoutes.detail(runId))).json()).status,
        { timeout: 15_000 }
      )
      .toBe("completed")
  } finally {
    await server?.stop().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}

const chatSteps = (requests: ReadonlyArray<ModelProviderRequest>) =>
  requests
    .filter((request) => request.cacheScope !== undefined)
    .map((request) => request.maxOutputTokens)

describe("a chat step's output limit", () => {
  it(
    "is the room the window leaves above the compaction trigger",
    { timeout: 30_000 },
    async () => {
      const model = recording()
      await chatTurn(model.provider, host())
      expect(chatSteps(model.requests)).toEqual([32_768 - 26_214])
    }
  )

  it("is never more than the model's own output cap", { timeout: 30_000 }, async () => {
    const model = recording()
    await chatTurn(model.provider, host(1_024))
    expect(chatSteps(model.requests)).toEqual([1_024])
  })

  it("is not set on a route that sends no output limit", { timeout: 30_000 }, async () => {
    const model = recording("omitted")
    await chatTurn(model.provider, host())
    expect(chatSteps(model.requests)).toEqual([undefined])
  })
})
