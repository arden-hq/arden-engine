import { resolveModelCapabilities } from "@arden-hq/loop"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { modelsFor } from "../src/serve/models.js"
import { parseSettings, SettingsError } from "../src/serve/settings.js"

const GEMMA = "ggml-org/gemma-4-E2B-it-GGUF:Q8_0"
const LLAMA = "http://127.0.0.1:9931"

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`fixtures/chat-completions/${name}`, import.meta.url), "utf8"))

const serving =
  (routes: Readonly<Record<string, unknown>>): typeof globalThis.fetch =>
  async (url) => {
    const body = routes[String(url)]
    return body === undefined ? new Response("Not Found", { status: 404 }) : Response.json(body)
  }

const llamaRouter = async () =>
  serving({
    [`${LLAMA}/props`]: await fixture("llama-router-props.json"),
    [`${LLAMA}/v1/models`]: await fixture("llama-router-models-loaded.json"),
    [`${LLAMA}/props?model=${encodeURIComponent(GEMMA)}&autoload=false`]: await fixture(
      "llama-router-child-props.json"
    )
  })

const settings = (fields: Record<string, unknown>) =>
  parseSettings({ dataDirectory: "/tmp/arden-models", ...fields })

const inherit = { modelId: null, reasoningEffort: null }

describe("modelsFor a chat-completions provider", () => {
  it("lists a detected llama.cpp server's only model with its own window", async () => {
    const route = await modelsFor(
      settings({ provider: { kind: "chat-completions", baseUrl: `${LLAMA}/v1/` } }),
      { env: {}, fetch: await llamaRouter() }
    )
    expect(route.modelHost).toEqual({
      models: [
        {
          id: GEMMA,
          name: GEMMA,
          provider: { id: "llama.cpp", name: "llama.cpp" },
          reasoningEfforts: ["none"],
          context: { hardLimit: 4096, compactionTrigger: 3276 }
        }
      ],
      defaults: {
        chatModelId: GEMMA,
        reasoningEfforts: {},
        roles: { background: inherit, helper: inherit }
      }
    })
    expect(Object.keys(route)).toEqual(["provider", "modelHost"])
    const provider = route.provider
    if (provider === undefined) throw new Error("no provider")
    expect(await resolveModelCapabilities({ provider, model: GEMMA })).toMatchObject({
      structuredOutput: "native",
      imageInput: { limits: undefined }
    })
  })

  it("lets contextLimit lower a reported window but never raise it", async () => {
    const lowered = await modelsFor(
      settings({
        provider: { kind: "chat-completions", baseUrl: `${LLAMA}/v1`, server: "llama.cpp" },
        model: GEMMA,
        contextLimit: 2000
      }),
      { env: {}, fetch: await llamaRouter() }
    )
    expect(lowered.modelHost).toMatchObject({
      models: [{ id: GEMMA, context: { hardLimit: 2000, compactionTrigger: 1600 } }]
    })
    await expect(
      modelsFor(
        settings({
          provider: { kind: "chat-completions", baseUrl: `${LLAMA}/v1`, server: "llama.cpp" },
          model: GEMMA,
          contextLimit: 8000
        }),
        { env: {}, fetch: await llamaRouter() }
      )
    ).rejects.toThrow(SettingsError)
  })

  it("lists OpenRouter models with their own windows and efforts, keyed from the environment", async () => {
    const seen: Array<string | null> = []
    const list = await fixture("openrouter-models.json")
    const route = await modelsFor(
      settings({
        provider: {
          kind: "chat-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_KEY"
        },
        model: "deepseek/deepseek-v4.1-flash-1017",
        reasoningEffort: "low",
        extraModels: ["anthropic/claude-haiku-5.5"],
        helperModel: "anthropic/claude-haiku-5.5"
      }),
      {
        env: { OPENROUTER_KEY: "sk-test" },
        fetch: async (url, init) => {
          seen.push(new Headers(init?.headers).get("authorization"))
          return String(url) === "https://openrouter.ai/api/v1/models"
            ? Response.json(list)
            : new Response("Not Found", { status: 404 })
        }
      }
    )
    expect(seen).toEqual(["Bearer sk-test"])
    const openRouter = { id: "openrouter", name: "OpenRouter" }
    expect(route.modelHost).toEqual({
      models: [
        {
          id: "deepseek/deepseek-v4.1-flash-1017",
          name: "deepseek/deepseek-v4.1-flash-1017",
          provider: openRouter,
          reasoningEfforts: ["max", "high", "low", "none"],
          context: { hardLimit: 1_048_576, compactionTrigger: 838_860, outputCap: 384_000 }
        },
        {
          id: "anthropic/claude-haiku-5.5",
          name: "anthropic/claude-haiku-5.5",
          provider: openRouter,
          reasoningEfforts: ["max", "xhigh", "high", "medium", "low", "none"],
          context: { hardLimit: 1_000_000, compactionTrigger: 800_000, outputCap: 128_000 }
        }
      ],
      defaults: {
        chatModelId: "deepseek/deepseek-v4.1-flash-1017",
        reasoningEfforts: { "deepseek/deepseek-v4.1-flash-1017": "low" },
        roles: {
          background: inherit,
          helper: { modelId: "anthropic/claude-haiku-5.5", reasoningEffort: null }
        }
      }
    })
  })

  it("takes a generic server's model and window from the settings, after detection says generic", async () => {
    const route = await modelsFor(
      settings({
        provider: { kind: "chat-completions", baseUrl: "http://127.0.0.1:8000/v1" },
        model: "served",
        contextLimit: 32_000
      }),
      { env: {}, fetch: serving({}) }
    )
    expect(route.modelHost).toMatchObject({
      models: [
        {
          id: "served",
          provider: { id: "chat-completions", name: "Chat Completions" },
          reasoningEfforts: [],
          context: { hardLimit: 32_000, compactionTrigger: 25_600 }
        }
      ]
    })
    await expect(
      modelsFor(
        settings({ provider: { kind: "chat-completions", baseUrl: "http://127.0.0.1:8000/v1" } }),
        { env: {}, fetch: serving({}) }
      )
    ).rejects.toThrow(SettingsError)
  })
})
