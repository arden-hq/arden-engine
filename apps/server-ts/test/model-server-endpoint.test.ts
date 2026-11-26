import { newChat } from "./fixtures/new-chat.js"
import { MODEL_PROVIDER_PROTOCOL } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ModelProvider, ModelProviderRequest } from "@arden-hq/loop"
import { chatDecoders, chatRequests, chatRoutes } from "@arden-hq/protocol/chat"
import {
  modelEndpointDecoders,
  modelEndpointRequests,
  modelEndpointRoutes,
  type ChatEndpointDraft
} from "@arden-hq/protocol/model-endpoints"
import { modelDecoders, modelRequests, modelRoutes } from "@arden-hq/protocol/models"
import { runDecoders, runRoutes } from "@arden-hq/protocol/runs"
import { sessionDecoders, sessionRequests, sessionRoutes } from "@arden-hq/protocol/sessions"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { startServer, type ServerHandle, type ServerOptions } from "../src/index.js"
import type { ModelHost } from "../src/models/host.js"
import { memoryServerVault } from "./fixtures/memory-vault.js"

const headers = { "content-type": "application/json" }
const GEMMA = "gemma-4"
const QWEN = "qwen-4"
const CODEX = "openai-codex/gpt-test"
const fakeLlama = async (model = GEMMA) => {
  const chats: Array<Record<string, unknown>> = []
  const keys: Array<string | undefined> = []
  const server: Server = createServer((request, response) => {
    const json = (body: unknown) => {
      response.writeHead(200, headers)
      response.end(JSON.stringify(body))
    }
    if (request.url === "/props")
      return json({
        build_info: "b12359-test",
        default_generation_settings: { n_ctx: 32_768 },
        chat_template_caps: { supports_tools: true }
      })
    if (request.url === "/v1/models") return json({ data: [{ id: model }] })
    if (request.url === "/v1/chat/completions") {
      let body = ""
      keys.push(request.headers.authorization?.replace(/^Bearer /u, ""))
      request.on("data", (chunk: Buffer) => (body += chunk.toString()))
      request.on("end", () => {
        chats.push(JSON.parse(body))
        response.writeHead(200, { "content-type": "text/event-stream" })
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
        response.end(
          `${chunk({ content: "Done." }, null)}${chunk({}, "stop")}data: ${JSON.stringify({ id: "c", choices: [], usage })}\n\ndata: [DONE]\n\n`
        )
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  const port = address.port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    host: `127.0.0.1:${port}`,
    chats,
    keys,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
const codexHost: ModelHost = {
  models: [
    {
      id: CODEX,
      name: "GPT test",
      provider: { id: "openai-codex", name: "OpenAI Codex" },
      reasoningEfforts: [],
      context: { hardLimit: 128_000, compactionTrigger: 100_000 }
    }
  ],
  defaults: {
    chatModelId: CODEX,
    reasoningEfforts: {},
    roles: {
      background: { modelId: null, reasoningEffort: null },
      helper: { modelId: null, reasoningEffort: null }
    }
  }
}

const codexProvider = () => {
  const requests: Array<ModelProviderRequest> = []
  const provider: ModelProvider = {
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    capabilities: () => ({ hostedTools: [], structuredOutput: "native" }),
    stream: (request) => {
      requests.push(request)
      return [
        {
          _tag: "Completed",
          message: {
            role: ROLE.assistant,
            content: "Fine.",
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
  return { provider, requests }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

const started = async (options: Partial<ServerOptions>, directory?: string) => {
  const folder = directory ?? (await mkdtemp(join(tmpdir(), "arden-model-server-")))
  if (directory === undefined) cleanups.push(() => rm(folder, { recursive: true, force: true }))
  let changes = 0
  const server: ServerHandle = await startServer({
    port: 0,
    databasePath: join(folder, "arden.db"),
    sharedSkillRoots: [],
    memory: false,
    idleCompactionAfterMs: 0,
    onModelListChange: () => {
      changes += 1
    },
    ...options
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await server.stop()
  }
  cleanups.push(stop)
  const call = async (path: string, init?: RequestInit) => {
    const response = await server.fetch(path, init)
    const text = await response.text()
    const body: unknown = text === "" ? undefined : JSON.parse(text)
    return { status: response.status, body }
  }
  return { server, folder, call, changes: () => changes, stop }
}

type Running = Awaited<ReturnType<typeof started>>

const llamaDraft = (baseUrl: string): ChatEndpointDraft => ({
  service: "llama.cpp",
  baseUrl,
  auth: { kind: "none" }
})
const save = async (running: Running, draft: ChatEndpointDraft, id?: string) =>
  modelEndpointDecoders.chatSave(
    (
      await running.call(
        id === undefined ? modelEndpointRoutes.chatServers : modelEndpointRoutes.chatServer(id),
        {
          method: id === undefined ? "POST" : "PUT",
          headers,
          body: modelEndpointRequests.chatDraft(draft)
        }
      )
    ).body
  )

const saved = async (running: Running, draft: ChatEndpointDraft) => {
  const result = await save(running, draft)
  if (result.result !== "saved") throw new Error(`not saved: ${JSON.stringify(result)}`)
  return result.endpoint
}
const check = async (running: Running, draft: ChatEndpointDraft, id?: string) => {
  const response = await running.call(
    id === undefined ? modelEndpointRoutes.chatCheck : modelEndpointRoutes.chatServerCheck(id),
    { method: "POST", headers, body: modelEndpointRequests.chatDraft(draft) }
  )
  return response.status === 200
    ? modelEndpointDecoders.chatCheck(response.body)
    : { status: response.status }
}

const remove = async (running: Running, id: string) =>
  modelEndpointDecoders.endpoints(
    (await running.call(modelEndpointRoutes.chatServer(id), { method: "DELETE" })).body
  )

const groups = async (running: Running) =>
  modelDecoders
    .catalog((await running.call(modelRoutes.catalog)).body)
    .providers.map((group) => [group.name, group.models.map((model) => model.id)])

const endpoints = async (running: Running) =>
  modelEndpointDecoders.endpoints((await running.call(modelEndpointRoutes.list)).body)
const chatOn = async (running: Running, model: string) => {
  const sessionId = sessionDecoders.createResponse(
    (
      await running.call(sessionRoutes.collection, {
        method: "POST",
        headers,
        body: JSON.stringify(newChat())
      })
    ).body
  ).session_id
  expect(
    (
      await running.call(sessionRoutes.model(sessionId), {
        method: "PUT",
        headers,
        body: sessionRequests.setModel({ kind: "pinned", model_id: model })
      })
    ).status
  ).toBe(200)
  const receipt = chatDecoders.receipt(
    (
      await running.call(chatRoutes.message, {
        method: "POST",
        headers,
        body: chatRequests.message({ sessionId, message: "Hi" }).body
      })
    ).body
  )
  const runId = receipt.runId
  if (runId === null) throw new Error("no run")
  const status = async () =>
    runDecoders.detail((await running.call(runRoutes.detail(runId))).body).status
  await expect
    .poll(status, { timeout: 60_000, interval: 200 })
    .toSatisfy((value) => value === "completed" || value === "error")
  return status()
}

describe("the model server beside the signed-in account", () => {
  it(
    "lists its models as a second group, sends each request to its own route, and takes them away on removal",
    { timeout: 60_000 },
    async () => {
      const llama = await fakeLlama()
      cleanups.push(llama.close)
      const codex = codexProvider()
      const running = await started({ provider: codex.provider, modelHost: codexHost })
      expect(await groups(running)).toEqual([["OpenAI Codex", [CODEX]]])

      const result = await save(running, llamaDraft(llama.baseUrl))
      const id = result.result === "saved" ? result.endpoint.id : ""
      expect(result).toEqual({
        result: "saved",
        endpoint: {
          kind: "chat",
          id: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
          service: "llama.cpp",
          baseUrl: llama.baseUrl,
          host: llama.host,
          group: "llama.cpp",
          auth: { kind: "none" },
          models: [{ id: GEMMA, contextWindow: 32_768, imageInput: false }],
          skipped: [],
          health: { state: "works" }
        }
      })
      expect(running.changes()).toBe(1)
      expect(await groups(running)).toEqual([
        ["OpenAI Codex", [CODEX]],
        ["llama.cpp", [GEMMA]]
      ])

      llama.chats.length = 0
      expect(await chatOn(running, GEMMA)).toBe("completed")
      expect(llama.chats.some((body) => body["model"] === GEMMA)).toBe(true)
      expect(codex.requests.every((request) => request.model === CODEX)).toBe(true)
      const codexCalls = codex.requests.length
      expect(await chatOn(running, CODEX)).toBe("completed")
      expect(codex.requests.length).toBeGreaterThan(codexCalls)
      expect(
        (
          await running.call(modelRoutes.settings, {
            method: "PATCH",
            headers,
            body: modelRequests.update([
              { kind: "chat_model", model: { kind: "model", modelId: GEMMA } },
              { kind: "role_model", role: "helper", model: { kind: "model", modelId: GEMMA } }
            ])
          })
        ).status
      ).toBe(200)

      expect((await remove(running, id)).chat).toEqual([])
      expect(running.changes()).toBe(2)
      expect(await groups(running)).toEqual([["OpenAI Codex", [CODEX]]])
      expect((await running.call(modelRoutes.settings)).status).toBe(200)
    }
  )

  it("keeps each server's key in the vault alone, uses it for an edit that keeps it, and removes it with its server", async () => {
    const first = await fakeLlama(GEMMA)
    const second = await fakeLlama(QWEN)
    cleanups.push(first.close, second.close)
    const documents = new Map<string, unknown>()
    const running = await started({ credentialVault: memoryServerVault(documents) })
    const keyed = (baseUrl: string, model: string, apiKey: string): ChatEndpointDraft => ({
      service: "custom",
      baseUrl,
      models: [model],
      auth: { kind: "bearer", apiKey }
    })
    const firstDraft = keyed(first.baseUrl, GEMMA, "sk-first-123")
    const response = await running.call(modelEndpointRoutes.chatServers, {
      method: "POST",
      headers,
      body: modelEndpointRequests.chatDraft(firstDraft)
    })
    expect(JSON.stringify(response.body)).not.toContain("sk-first-123")
    const one = modelEndpointDecoders.chatSave(response.body)
    expect(one).toMatchObject({
      result: "saved",
      endpoint: { group: first.host, auth: { kind: "bearer" } }
    })
    const oneId = one.result === "saved" ? one.endpoint.id : ""
    const two = await saved(running, keyed(second.baseUrl, QWEN, "sk-second-456"))
    expect([...documents.values()]).toEqual([
      { secret: "sk-first-123" },
      { secret: "sk-second-456" }
    ])
    expect(first.keys).toEqual(["sk-first-123"])
    expect(second.keys).toEqual(["sk-second-456"])
    expect(JSON.stringify((await running.call(modelEndpointRoutes.list)).body)).not.toContain("sk-")
    const kept: ChatEndpointDraft = { ...firstDraft, auth: { kind: "keep" } }
    expect(await check(running, kept)).toEqual({ status: 422 })
    expect(await check(running, kept, oneId)).toMatchObject({ result: "works" })
    expect(first.keys.at(-1)).toBe("sk-first-123")
    expect(await check(running, { ...kept, baseUrl: second.baseUrl }, oneId)).toEqual({
      status: 422
    })
    expect(second.keys).toEqual(["sk-second-456"])
    const edited = await save(running, { ...kept, models: [GEMMA, "gemma-4-fast"] }, oneId)
    expect(edited).toMatchObject({
      result: "saved",
      endpoint: { id: oneId, models: [{ id: GEMMA }, { id: "gemma-4-fast" }] }
    })
    expect(first.keys.at(-1)).toBe("sk-first-123")
    expect([...documents.values()]).toEqual([
      { secret: "sk-first-123" },
      { secret: "sk-second-456" }
    ])
    expect((await endpoints(running)).chat.map((server) => server.id)).toEqual([oneId, two.id])

    await remove(running, oneId)
    expect([...documents.values()]).toEqual([{ secret: "sk-second-456" }])
    expect(
      (await running.call(modelEndpointRoutes.chatServer(oneId), { method: "DELETE" })).status
    ).toBe(404)
  })
})
