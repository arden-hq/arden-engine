import { describe, expect, it } from "vitest"
import { checkChatEndpoint, type ChatEndpointTarget } from "../src/models/endpoints/chat.js"

const LLAMA = "http://127.0.0.1:8080"
const props = (nCtx: number, tools = true) => ({
  build_info: "b12359-test",
  default_generation_settings: { n_ctx: nCtx },
  modalities: { vision: false },
  chat_template_caps: { supports_tools: tools, supports_parallel_tool_calls: false }
})

const chunk = (delta: unknown, finish: string | null = null) => ({
  choices: [{ finish_reason: finish, index: 0, delta }],
  id: "chatcmpl-1",
  model: "served",
  object: "chat.completion.chunk"
})

const answer = (): Response =>
  new Response(
    [
      chunk({ content: "OK" }),
      chunk({}, "stop"),
      {
        choices: [],
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 }
      },
      "[DONE]"
    ]
      .map((item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  )

interface Served {
  readonly routes: Readonly<Record<string, unknown>>
  readonly chat?: () => Response
}
const serving = ({ routes, chat = answer }: Served) => {
  const bodies: Array<Record<string, unknown>> = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.endsWith("/chat/completions")) {
      bodies.push(JSON.parse(String(init?.body)))
      return chat()
    }
    const body = routes[path]
    return body === undefined ? new Response("Not Found", { status: 404 }) : Response.json(body)
  }
  return { fetch, bodies }
}

const llamaRouter = (models: Readonly<Record<string, ReturnType<typeof props>>>) =>
  Object.fromEntries([
    [`${LLAMA}/props`, { build_info: "b12359-test", role: "router" }],
    [`${LLAMA}/v1/models`, { data: Object.keys(models).map((id) => ({ id })) }],
    ...Object.entries(models).map(([id, body]) => [
      `${LLAMA}/props?model=${encodeURIComponent(id)}&autoload=false`,
      body
    ])
  ])

const llama = (fetch: typeof globalThis.fetch): ChatEndpointTarget => ({
  service: "llama.cpp",
  baseUrl: `${LLAMA}/v1`,
  key: undefined,
  fetch
})

const fixedClock = { now: () => 0 }

describe("the model server Check", () => {
  it("offers a llama.cpp server's usable models, says why it skips the others, and asks the first once", async () => {
    const server = serving({
      routes: llamaRouter({
        "gemma-32k": props(32_768),
        "gemma-16k": props(16_384),
        plain: props(65_536, false),
        "openai-codex/gpt-6": props(65_536)
      })
    })
    expect(await checkChatEndpoint(llama(server.fetch), fixedClock)).toEqual({
      result: "works",
      models: [
        {
          id: "gemma-32k",
          window: 32_768,
          outputCap: null,
          reasoningEfforts: ["none"],
          compat: expect.objectContaining({ maxTokensField: "max_tokens", imageInput: false })
        }
      ],
      skipped: [
        { id: "gemma-16k", reason: "window_too_small", window: 16_384 },
        { id: "plain", reason: "no_tool_calls" },
        { id: "openai-codex/gpt-6", reason: "model_taken" }
      ],
      ms: 0
    })
    expect(server.bodies.map((body) => body["model"])).toEqual(["gemma-32k"])
  })

  it("refuses a server whose every model is ruled out, by the first model's reason", async () => {
    const small = serving({ routes: llamaRouter({ "gemma-16k": props(16_384) }) })
    expect(await checkChatEndpoint(llama(small.fetch))).toMatchObject({
      result: "window_too_small",
      model: "gemma-16k",
      window: 16_384,
      needed: 32_768
    })
    const toolless = serving({ routes: llamaRouter({ plain: props(65_536, false) }) })
    expect(await checkChatEndpoint(llama(toolless.fetch))).toMatchObject({
      result: "no_tool_calls",
      model: "plain"
    })
    expect(small.bodies).toEqual([])
    expect(toolless.bodies).toEqual([])
  })

  it("proves an OpenRouter key with the chat request, since the model list needs none", async () => {
    const list = {
      data: [
        {
          id: "openai/gpt-6-luna",
          context_length: 400_000,
          top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
          supported_parameters: ["tools", "max_tokens"]
        }
      ]
    }
    const refused = serving({
      routes: { "https://openrouter.ai/api/v1/models": list },
      chat: () =>
        Response.json(
          { error: { code: 401, message: "No cookie auth credentials found" } },
          { status: 401 }
        )
    })
    expect(
      await checkChatEndpoint({
        service: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        models: ["openai/gpt-6-luna"],
        key: "sk-or-wrong",
        fetch: refused.fetch
      })
    ).toMatchObject({ result: "key_refused" })
    const missing = serving({ routes: { "https://openrouter.ai/api/v1/models": list } })
    expect(
      await checkChatEndpoint({
        service: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        models: ["openai/gpt-6-luna", "vendor/none"],
        key: "sk-or-test",
        fetch: missing.fetch
      })
    ).toMatchObject({ result: "model_missing", model: "vendor/none" })
  })

  it("never sends a key over plain HTTP to another machine", async () => {
    const server = serving({ routes: {} })
    expect(
      await checkChatEndpoint({
        service: "custom",
        baseUrl: "http://10.0.0.5:8000/v1",
        models: ["served"],
        key: "secret",
        fetch: server.fetch
      })
    ).toMatchObject({ result: "address_refused", issue: "insecure" })
    expect(server.bodies).toEqual([])
  })

  it("offers every named OpenRouter model with its own abilities and asks only the first", async () => {
    const server = serving({
      routes: {
        "https://openrouter.ai/api/v1/models": {
          data: [
            {
              id: "openai/gpt-6-luna",
              context_length: 400_000,
              top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
              architecture: { input_modalities: ["text", "image"] },
              supported_parameters: ["tools", "max_tokens", "reasoning"]
            },
            {
              id: "anthropic/claude-haiku-5.5",
              context_length: 200_000,
              top_provider: { context_length: 200_000, max_completion_tokens: 64_000 },
              architecture: { input_modalities: ["text"] },
              supported_parameters: ["tools", "max_tokens"]
            }
          ]
        }
      }
    })
    const result = await checkChatEndpoint(
      {
        service: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        models: ["anthropic/claude-haiku-5.5", "openai/gpt-6-luna"],
        key: "sk-or-test",
        fetch: server.fetch
      },
      fixedClock
    )
    expect(result).toMatchObject({
      result: "works",
      models: [
        { id: "anthropic/claude-haiku-5.5", window: 200_000, outputCap: 64_000 },
        { id: "openai/gpt-6-luna", window: 400_000, outputCap: 128_000 }
      ],
      skipped: []
    })
    expect(
      result.result === "works" && result.models.map((model) => model.compat.imageInput)
    ).toEqual([false, true])
    expect(server.bodies.map((body) => body["model"])).toEqual(["anthropic/claude-haiku-5.5"])
  })

  it("skips a listed model another server offers, and refuses a named one", async () => {
    const taken = new Map([["gemma-32k", "llama.cpp"]])
    const router = serving({
      routes: llamaRouter({ "gemma-32k": props(32_768), "qwen-64k": props(65_536) })
    })
    expect(await checkChatEndpoint(llama(router.fetch), { ...fixedClock, taken })).toMatchObject({
      result: "works",
      models: [{ id: "qwen-64k" }],
      skipped: [{ id: "gemma-32k", reason: "model_taken" }]
    })
    const custom = serving({ routes: {} })
    expect(
      await checkChatEndpoint(
        {
          service: "custom",
          baseUrl: "http://127.0.0.1:8000/v1",
          models: ["served", "gemma-32k"],
          key: undefined,
          fetch: custom.fetch
        },
        { taken }
      )
    ).toMatchObject({ result: "model_taken", model: "gemma-32k" })
    expect(custom.bodies).toEqual([])
  })
})
