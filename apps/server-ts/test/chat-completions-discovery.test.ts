import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import {
  detectServer,
  discoverLlamaCpp,
  discoverOpenRouter,
  DiscoveryError,
  UnreachableError,
  type DiscoveryInput
} from "../src/providers/chat-completions/discovery.js"

// Real bodies, captured on 2026-11-15: llama.cpp b12359 (a router with a
// loaded model, a router with two unloaded models, a single-model server) and
// OpenRouter's public `/models` cut to six entries. Template text and the
// owner's home folder are cut.
const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`fixtures/chat-completions/${name}`, import.meta.url), "utf8"))

const GEMMA = "ggml-org/gemma-4-E2B-it-GGUF:Q8_0"

interface Served {
  readonly status: number
  readonly body: unknown
}

/** A server that answers the listed URLs and records every request. */
const server = (routes: Readonly<Record<string, Served>>) => {
  const requested: Array<string> = []
  const input = (baseUrl: string): DiscoveryInput => ({
    baseUrl,
    headers: { authorization: "Bearer test" },
    signal: AbortSignal.timeout(5_000),
    fetch: async (url, init) => {
      requested.push(String(url))
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test")
      const route = routes[String(url)]
      return route === undefined
        ? new Response("Not Found", { status: 404 })
        : Response.json(route.body, { status: route.status })
    }
  })
  return { input, requested }
}

const ok = (body: unknown): Served => ({ status: 200, body })
const notLoaded: Served = {
  status: 400,
  body: { error: { code: 400, message: "model is not loaded", type: "invalid_request_error" } }
}

const conservative = {
  maxTokensField: "max_tokens",
  systemRole: "system",
  reasoningEffort: "reasoning_effort",
  usageInStream: true,
  structuredOutput: "json_schema",
  imageInput: false,
  parallelToolCalls: false,
  cacheControl: "none",
  toolChoiceNone: "unenforced"
}

describe("detectServer", () => {
  it("knows OpenRouter by its host, llama.cpp by /props, and anything else as generic", async () => {
    const llama = server({
      "http://127.0.0.1:9931/props": ok(await fixture("llama-router-props.json"))
    })
    expect(await detectServer(llama.input("http://127.0.0.1:9931/v1"))).toBe("llama.cpp")
    // Under `--api-prefix` the props sit beside `/v1`, not at the origin.
    const prefixed = server({ "http://127.0.0.1:9931/llm/props": ok({ build_info: "b1" }) })
    expect(await detectServer(prefixed.input("http://127.0.0.1:9931/llm/v1"))).toBe("llama.cpp")
    const openRouter = server({})
    expect(await detectServer(openRouter.input("https://openrouter.ai/api/v1"))).toBe("openrouter")
    expect(openRouter.requested).toEqual([])
    const other = server({ "http://127.0.0.1:8000/props": ok({ status: "ok" }) })
    expect(await detectServer(other.input("http://127.0.0.1:8000/v1"))).toBe("generic")
    expect(await detectServer(server({}).input("http://127.0.0.1:8000/v1"))).toBe("generic")
  })

  it("reports a server it cannot reach instead of calling it generic", async () => {
    await expect(
      detectServer({
        baseUrl: "http://127.0.0.1:1/v1",
        headers: {},
        signal: AbortSignal.timeout(5_000),
        fetch: async () => {
          throw new TypeError("fetch failed")
        }
      })
    ).rejects.toThrow(new UnreachableError("cannot reach http://127.0.0.1:1/props: fetch failed"))
  })
})

describe("discoverLlamaCpp", () => {
  it("reads a loaded router model's window and abilities from its own /props, without loading it", async () => {
    const llama = server({
      "http://127.0.0.1:9931/props": ok(await fixture("llama-router-props.json")),
      "http://127.0.0.1:9931/v1/models": ok(await fixture("llama-router-models-loaded.json")),
      [`http://127.0.0.1:9931/props?model=${encodeURIComponent(GEMMA)}&autoload=false`]: ok(
        await fixture("llama-router-child-props.json")
      )
    })
    expect(await discoverLlamaCpp(llama.input("http://127.0.0.1:9931/v1"), undefined)).toEqual([
      {
        id: GEMMA,
        contextLimit: 4096,
        reasoningEfforts: ["none"],
        compat: { ...conservative, imageInput: true, parallelToolCalls: true }
      }
    ])
  })

  it("takes an unloaded router model's window from its --ctx-size and assumes nothing else", async () => {
    const llama = server({
      "http://127.0.0.1:9951/props": ok(await fixture("llama-router-props.json")),
      "http://127.0.0.1:9951/v1/models": ok(await fixture("llama-router-models-unloaded.json")),
      "http://127.0.0.1:9951/props?model=gemma-32k&autoload=false": notLoaded,
      "http://127.0.0.1:9951/props?model=gemma-8k&autoload=false": notLoaded
    })
    const input = llama.input("http://127.0.0.1:9951/v1")
    expect(await discoverLlamaCpp(input, ["gemma-8k", "gemma-32k"])).toEqual([
      { id: "gemma-8k", contextLimit: 8192, reasoningEfforts: ["none"], compat: conservative },
      { id: "gemma-32k", contextLimit: 32768, reasoningEfforts: ["none"], compat: conservative }
    ])
    await expect(discoverLlamaCpp(input, undefined)).rejects.toThrow(
      "The llama.cpp server lists several models; set `model` to one of: gemma-32k, gemma-8k, ggml-org/gemma-4-E2B-it-GGUF:Q8_0"
    )
    await expect(discoverLlamaCpp(input, ["gemma"])).rejects.toThrow(
      "Model is not on the llama.cpp server: gemma (it lists: gemma-32k, gemma-8k, ggml-org/gemma-4-E2B-it-GGUF:Q8_0)"
    )
  })

  it("reports a router's other 400 as the error it is, not as an unloaded model", async () => {
    const llama = server({
      "http://127.0.0.1:9951/props": ok(await fixture("llama-router-props.json")),
      "http://127.0.0.1:9951/v1/models": ok(await fixture("llama-router-models-unloaded.json")),
      "http://127.0.0.1:9951/props?model=gemma-8k&autoload=false": {
        status: 400,
        body: {
          error: { code: 400, message: "model 'gemma-8k' not found", type: "invalid_request_error" }
        }
      }
    })
    await expect(
      discoverLlamaCpp(llama.input("http://127.0.0.1:9951/v1"), ["gemma-8k"])
    ).rejects.toThrow(
      "http://127.0.0.1:9951/props for gemma-8k answered HTTP 400: model 'gemma-8k' not found"
    )
  })

  it("leaves the window unknown when no source gives one", async () => {
    // The router also lists a model from the download cache, started with no `--ctx-size`.
    const llama = server({
      "http://127.0.0.1:9951/props": ok(await fixture("llama-router-props.json")),
      "http://127.0.0.1:9951/v1/models": ok(await fixture("llama-router-models-unloaded.json")),
      [`http://127.0.0.1:9951/props?model=${encodeURIComponent(GEMMA)}&autoload=false`]: notLoaded
    })
    expect(await discoverLlamaCpp(llama.input("http://127.0.0.1:9951/v1"), [GEMMA])).toEqual([
      { id: GEMMA, contextLimit: undefined, reasoningEfforts: ["none"], compat: conservative }
    ])
  })

  it("reads a single-model server's /props as its one model's", async () => {
    const models = await fixture("llama-single-models.json")
    const llama = server({
      "http://127.0.0.1:9952/props": ok(await fixture("llama-single-props.json")),
      "http://127.0.0.1:9952/v1/models": ok(models)
    })
    const [model] = await discoverLlamaCpp(llama.input("http://127.0.0.1:9952/v1"), undefined)
    expect(model).toEqual({
      id: "/Users/owner/.cache/huggingface/hub/models--ggml-org--gemma-4-E2B-it-GGUF/snapshots/2a8538c2e2d4687953a86c422c7c623cfd022880/gemma-4-E2B-it-Q8_0.gguf",
      contextLimit: 2048,
      reasoningEfforts: ["none"],
      compat: { ...conservative, parallelToolCalls: true }
    })
    expect(llama.requested).toEqual([
      "http://127.0.0.1:9952/props",
      "http://127.0.0.1:9952/v1/models"
    ])
  })

  it("offers the server's thinking switch before the template's levels", async () => {
    const props = await fixture("llama-single-props.json")
    const levels: unknown = JSON.parse(
      JSON.stringify(props)
        .replace('"supports_reasoning_effort":false', '"supports_reasoning_effort":true')
        .replace(
          '"reasoning_effort_levels":[]',
          '"reasoning_effort_levels":["low","medium","high"]'
        )
    )
    const llama = server({
      "http://127.0.0.1:9952/props": ok(levels),
      "http://127.0.0.1:9952/v1/models": ok({ data: [{ id: "m" }] })
    })
    const [model] = await discoverLlamaCpp(llama.input("http://127.0.0.1:9952/v1"), undefined)
    expect(model?.reasoningEfforts).toEqual(["none", "low", "medium", "high"])
  })

  it("refuses a server that is not llama.cpp or a template without tools", async () => {
    await expect(
      discoverLlamaCpp(server({}).input("http://127.0.0.1:9952/v1"), undefined)
    ).rejects.toThrow("http://127.0.0.1:9952/props did not answer as llama.cpp (HTTP 404)")
    const props = await fixture("llama-single-props.json")
    const noTools: unknown = JSON.parse(
      JSON.stringify(props).replace('"supports_tools":true', '"supports_tools":false')
    )
    const llama = server({
      "http://127.0.0.1:9952/props": ok(noTools),
      "http://127.0.0.1:9952/v1/models": ok({ data: [{ id: "m" }] })
    })
    await expect(
      discoverLlamaCpp(llama.input("http://127.0.0.1:9952/v1"), undefined)
    ).rejects.toThrow("The chat template of m has no tool calls")
  })
})

describe("discoverOpenRouter", () => {
  const models = async () =>
    server({ "https://openrouter.ai/api/v1/models": ok(await fixture("openrouter-models.json")) })

  it("reads each model's window, efforts and request shape from the public list", async () => {
    const openRouter = await models()
    expect(
      await discoverOpenRouter(openRouter.input("https://openrouter.ai/api/v1"), [
        "anthropic/claude-haiku-4.5",
        "nvidia/nemotron-3.5-super-vl",
        "deepseek/deepseek-v4.1-flash-1017",
        "openai/gpt-4o-mini"
      ])
    ).toEqual([
      {
        id: "anthropic/claude-haiku-4.5",
        contextLimit: 200_000,
        outputCap: 64_000,
        reasoningEfforts: [],
        compat: {
          maxTokensField: "max_tokens",
          systemRole: "system",
          reasoningEffort: "openrouter",
          usageInStream: true,
          structuredOutput: "json_schema",
          imageInput: true,
          parallelToolCalls: false,
          cacheControl: "anthropic"
        }
      },
      {
        // The main provider's window is a quarter of the model's.
        id: "nvidia/nemotron-3.5-super-vl",
        contextLimit: 262_144,
        outputCap: 235_929,
        reasoningEfforts: [],
        compat: {
          maxTokensField: "max_tokens",
          systemRole: "system",
          reasoningEffort: "openrouter",
          usageInStream: true,
          structuredOutput: "json_schema",
          imageInput: true,
          parallelToolCalls: false,
          cacheControl: "none"
        }
      },
      {
        id: "deepseek/deepseek-v4.1-flash-1017",
        contextLimit: 1_048_576,
        outputCap: 384_000,
        reasoningEfforts: ["max", "high", "low", "none"],
        compat: {
          maxTokensField: "max_tokens",
          systemRole: "system",
          reasoningEffort: "openrouter",
          usageInStream: true,
          structuredOutput: "json_schema",
          imageInput: true,
          parallelToolCalls: true,
          cacheControl: "none"
        }
      },
      {
        id: "openai/gpt-4o-mini",
        contextLimit: 128_000,
        outputCap: 16_384,
        reasoningEfforts: [],
        compat: {
          maxTokensField: "max_tokens",
          systemRole: "system",
          reasoningEffort: "none",
          usageInStream: true,
          structuredOutput: "json_schema",
          imageInput: true,
          parallelToolCalls: false,
          cacheControl: "none"
        }
      }
    ])
  })

  it("reads efforts and cache breakpoints as the OpenRouter docs define them", async () => {
    const entry = (id: string, reasoning: unknown) => ({
      id,
      context_length: 131_072,
      supported_parameters: ["tools", "reasoning"],
      reasoning
    })
    const openRouter = server({
      "https://openrouter.ai/api/v1/models": ok({
        data: [
          entry("vendor/any-effort", { supported_efforts: null, mandatory: false }),
          entry("vendor/must-think", { supported_efforts: null, mandatory: true }),
          entry("vendor/no-choice", { mandatory: true }),
          entry("qwen/qwen3-max", { supported_efforts: ["high", "low", "none"], mandatory: false })
        ]
      })
    })
    const found = await discoverOpenRouter(openRouter.input("https://openrouter.ai/api/v1"), [
      "vendor/any-effort",
      "vendor/must-think",
      "vendor/no-choice",
      "qwen/qwen3-max"
    ])
    expect(
      found.map((model) => [model.id, model.reasoningEfforts, model.compat.cacheControl])
    ).toEqual([
      ["vendor/any-effort", ["max", "xhigh", "high", "medium", "low", "minimal", "none"], "none"],
      ["vendor/must-think", ["max", "xhigh", "high", "medium", "low", "minimal"], "none"],
      ["vendor/no-choice", [], "none"],
      ["qwen/qwen3-max", ["high", "low", "none"], "anthropic"]
    ])
  })

  it("refuses a model it does not list or that takes no tools", async () => {
    const input = (await models()).input("https://openrouter.ai/api/v1")
    await expect(discoverOpenRouter(input, ["vendor/nothing"])).rejects.toThrow(
      "Model is not on OpenRouter: vendor/nothing"
    )
    await expect(discoverOpenRouter(input, ["google/gemini-omni-1.2-flash"])).rejects.toThrow(
      "OpenRouter lists no tool calls for google/gemini-omni-1.2-flash"
    )
  })
})
