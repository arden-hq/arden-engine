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
import type { McpOAuthVault } from "../src/mcp/vault.js"
import type { ModelHost } from "../src/models/host.js"

const headers = { "content-type": "application/json" }
const GEMMA = "gemma-4"
const CODEX = "openai-codex/gpt-test"

/** A llama-server with one 32k model that calls tools; `down` drops every connection. */
const fakeLlama = async () => {
  const chats: Array<Record<string, unknown>> = []
  let down = false
  const server: Server = createServer((request, response) => {
    if (down) {
      request.socket.destroy()
      return
    }
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
    if (request.url === "/v1/models") return json({ data: [{ id: GEMMA }] })
    if (request.url === "/v1/chat/completions") {
      let body = ""
      request.on("data", (chunk: Buffer) => (body += chunk.toString()))
      request.on("end", () => {
        chats.push(JSON.parse(body))
        response.writeHead(200, { "content-type": "text/event-stream" })
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: GEMMA, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
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
    setDown: (value: boolean) => {
      down = value
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** The signed-in account's part, as the desktop host supplies it: one model, one provider. */
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
    protocolVersion: 1,
    capabilities: () => ({ hostedTools: [], structuredOutput: "native" }),
    stream: (request) => {
      requests.push(request)
      return [
        {
          _tag: "Completed",
          message: {
            role: "assistant",
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

/** The Electron vault, in memory. */
const memoryVault = () => {
  const documents = new Map<string, unknown>()
  const unused = async (): Promise<never> => {
    throw new Error("not used")
  }
  const vault: McpOAuthVault = {
    readDocument: async (target) => documents.get(target.documentKey) ?? null,
    writeDocument: async (target, value) => void documents.set(target.documentKey, value),
    clearDocument: async (target) => void documents.delete(target.documentKey),
    read: unused,
    write: unused,
    clear: unused,
    resolveClient: unused,
    readTransportSecrets: unused,
    writeTransportSecrets: unused,
    clearTransportSecrets: unused
  }
  return { vault, documents }
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
    const body: unknown = await response.json()
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

const save = async (running: Running, draft: ChatEndpointDraft) =>
  modelEndpointDecoders.chatSave(
    (
      await running.call(modelEndpointRoutes.endpoint("chat"), {
        method: "PUT",
        headers,
        body: modelEndpointRequests.chatDraft(draft)
      })
    ).body
  )

const groups = async (running: Running) =>
  modelDecoders
    .catalog((await running.call(modelRoutes.catalog)).body)
    .providers.map((group) => [group.name, group.models.map((model) => model.id)])

const endpoints = async (running: Running) =>
  modelEndpointDecoders.endpoints((await running.call(modelEndpointRoutes.list)).body)

/** One chat turn on `model`, to its end; the run's final status. */
const chatOn = async (running: Running, model: string) => {
  const sessionId = sessionDecoders.createResponse(
    (
      await running.call(sessionRoutes.collection, {
        method: "POST",
        headers,
        body: JSON.stringify({})
      })
    ).body
  ).session_id
  expect(
    (
      await running.call(sessionRoutes.model(sessionId), {
        method: "PUT",
        headers,
        body: sessionRequests.setModel(model)
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

      const saved = await save(running, llamaDraft(llama.baseUrl))
      expect(saved).toEqual({
        result: "saved",
        endpoint: {
          kind: "chat",
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
      // The chat step went to the server; the account answered only side jobs on its own model.
      expect(llama.chats.some((body) => body["model"] === GEMMA)).toBe(true)
      expect(codex.requests.every((request) => request.model === CODEX)).toBe(true)
      const codexCalls = codex.requests.length
      expect(await chatOn(running, CODEX)).toBe("completed")
      expect(codex.requests.length).toBeGreaterThan(codexCalls)

      // A server model as the model for new chats and the helper.
      expect(
        (
          await running.call(modelRoutes.settings, {
            method: "PATCH",
            headers,
            body: modelRequests.update({
              chatModelId: GEMMA,
              roles: { helper: { modelId: GEMMA } }
            })
          })
        ).status
      ).toBe(200)

      const removed = await running.call(modelEndpointRoutes.endpoint("chat"), {
        method: "DELETE"
      })
      expect(modelEndpointDecoders.endpoints(removed.body).chat).toBeNull()
      expect(running.changes()).toBe(2)
      expect(await groups(running)).toEqual([["OpenAI Codex", [CODEX]]])
      // The settings still name the removed model; nothing falls back, and reads still work.
      expect((await running.call(modelRoutes.settings)).status).toBe(200)
    }
  )

  it(
    "keeps a stopped server's models across a restart, marks it unreachable, and works again when it answers",
    { timeout: 120_000 },
    async () => {
      const llama = await fakeLlama()
      cleanups.push(llama.close)
      const first = await started({})
      expect((await save(first, llamaDraft(llama.baseUrl))).result).toBe("saved")
      await first.stop()

      llama.setDown(true)
      const second = await started({}, first.folder)
      // Nobody is signed in: the server's models are the whole list, and new chats start on them.
      expect(await groups(second)).toEqual([["llama.cpp", [GEMMA]]])
      await expect
        .poll(async () => (await endpoints(second)).chat?.health.state, { timeout: 30_000 })
        .toBe("failing")
      expect((await endpoints(second)).chat).toMatchObject({
        models: [{ id: GEMMA }],
        health: { state: "failing", reason: "unreachable" }
      })
      expect(await chatOn(second, GEMMA)).toBe("error")

      llama.setDown(false)
      expect(await chatOn(second, GEMMA)).toBe("completed")
      await expect
        .poll(async () => (await endpoints(second)).chat?.health.state, { timeout: 10_000 })
        .toBe("works")
    }
  )

  it("keeps a key in the vault alone, and an edit that keeps it does not retype it", async () => {
    const llama = await fakeLlama()
    cleanups.push(llama.close)
    const { vault, documents } = memoryVault()
    const running = await started({ credentialVault: vault })
    const keyed: ChatEndpointDraft = {
      service: "custom",
      baseUrl: llama.baseUrl,
      model: GEMMA,
      auth: { kind: "bearer", apiKey: "sk-secret-123" }
    }
    const saved = await running.call(modelEndpointRoutes.endpoint("chat"), {
      method: "PUT",
      headers,
      body: modelEndpointRequests.chatDraft(keyed)
    })
    expect(JSON.stringify(saved.body)).not.toContain("sk-secret-123")
    expect(modelEndpointDecoders.chatSave(saved.body)).toMatchObject({
      result: "saved",
      endpoint: { group: llama.host, auth: { kind: "bearer" } }
    })
    expect([...documents.values()]).toEqual([{ secret: "sk-secret-123" }])
    expect(llama.chats.at(-1)).toMatchObject({ model: GEMMA })
    expect(JSON.stringify((await running.call(modelEndpointRoutes.list)).body)).not.toContain(
      "sk-secret-123"
    )
    const kept = await running.call(modelEndpointRoutes.check("chat"), {
      method: "POST",
      headers,
      body: modelEndpointRequests.chatDraft({ ...keyed, auth: { kind: "keep" } })
    })
    expect(modelEndpointDecoders.chatCheck(kept.body)).toMatchObject({ result: "works" })
    await running.call(modelEndpointRoutes.endpoint("chat"), { method: "DELETE" })
    expect(documents.size).toBe(0)
  })
})
