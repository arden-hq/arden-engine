import { ROLE } from "@arden-hq/std/message-vocabulary"

import { renderInteraction } from "../src/agent/interactions.js"
import type { ModelProviderRequest } from "../src/contracts/provider.js"
import {
  makeChatCompletionsProvider,
  type ChatCompletionsProviderOptions
} from "../src/providers/chat-completions/provider.js"
import { makeToolSearch } from "../src/tools/search.js"
import { recordOf, scriptedFetch, sseResponse } from "./kit.js"

export const GEMMA = "ggml-org/gemma-4-E2B-it-GGUF:Q8_0"

export interface LlamaChunk {
  readonly choices: ReadonlyArray<{
    readonly finish_reason: string | null
    readonly index: number
    readonly delta: unknown
  }>
  readonly created: number
  readonly id: string
  readonly model: string
  readonly system_fingerprint: string
  readonly object: string
}

export const llamaChunk = (delta: unknown, finish: string | null = null): LlamaChunk => ({
  choices: [{ finish_reason: finish, index: 0, delta }],
  created: 1794771364,
  id: "chatcmpl-9Z4BdzrNvdRIaavSuacSnnIcNy1FUYZ7",
  model: GEMMA,
  system_fingerprint: "b12359-b1b770d90",
  object: "chat.completion.chunk"
})

export const llamaUsage = {
  choices: [],
  created: 1794771367,
  id: "chatcmpl-9Z4BdzrNvdRIaavSuacSnnIcNy1FUYZ7",
  model: GEMMA,
  system_fingerprint: "b12359-b1b770d90",
  object: "chat.completion.chunk",
  usage: {
    completion_tokens: 199,
    prompt_tokens: 76,
    total_tokens: 275,
    prompt_tokens_details: { cached_tokens: 71 }
  },
  timings: { cache_n: 71, prompt_n: 5, predicted_n: 199 }
}

export const LLAMA_OVERFLOW =
  '{"error":{"code":400,"message":"request (6016 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":6016,"n_ctx":4096}}'

export const answered =
  (text: string): (() => Response) =>
  () =>
    sseResponse([llamaChunk({ content: text }), llamaChunk({}, "stop"), llamaUsage, "[DONE]"])

export const weather = {
  name: "weather",
  description: "Weather for one city.",
  parameters: { type: "object" }
}

interface WeatherCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

export const call = (id: string, city = "Paris"): WeatherCall => ({
  id,
  type: "function" as const,
  function: { name: "weather", arguments: JSON.stringify({ city }) }
})

export const request = (overrides: Partial<ModelProviderRequest> = {}): ModelProviderRequest => ({
  model: GEMMA,
  messages: [{ role: ROLE.user, content: "Hi." }],
  renderInteraction,
  tools: [],
  deferredTools: [],
  toolChoice: "auto",
  ...overrides
})

export const provider = (
  answers: ReadonlyArray<() => Response>,
  options: Partial<ChatCompletionsProviderOptions> = {}
): {
  readonly transport: ReturnType<typeof scriptedFetch>
  readonly provider: ReturnType<typeof makeChatCompletionsProvider>
} => {
  const transport = scriptedFetch(answers)
  return {
    transport,
    provider: makeChatCompletionsProvider({
      providerId: "llama.cpp",
      baseUrl: "http://127.0.0.1:9931/v1/",
      fetch: transport.fetch,
      ...options
    })
  }
}

export const sentMessages = (body: unknown): unknown => recordOf(body).messages

export const shell = {
  name: "shell_run",
  description: "Run a shell command and return its output.\nUse for files and processes.",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  group: "system"
}

export const mail = {
  name: "mail_send",
  description: "Send an email.",
  parameters: { type: "object", properties: { to: { type: "string" } } },
  group: "mail"
}

const search = makeToolSearch({
  catalog: [shell, mail].map((declaration) => ({
    declaration,
    meta: { name: declaration.name, deferred: true, group: declaration.group }
  })),
  loaded: new Set()
})

export const searchTool = {
  type: "function",
  function: {
    name: "tool_search",
    description: search.description,
    parameters: search.parameters
  }
}

export const wire = (tool: {
  name: string
  description: string
  parameters: unknown
}): WireTool => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters }
})

export const searchRequest = (
  overrides: Partial<ModelProviderRequest> = {}
): ModelProviderRequest =>
  request({ tools: [weather], deferredTools: [shell, mail], toolSearch: search, ...overrides })

export const SHELL_LOADED =
  "Loaded 1 tool; call it directly now:\n- shell_run: Run a shell command and return its output."

export const searchChunk = (id: string, args: string, index = 0): LlamaChunk =>
  llamaChunk({
    tool_calls: [
      { index, id, type: "function", function: { name: "tool_search", arguments: args } }
    ]
  })

interface WireTool {
  readonly type: string
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: unknown
  }
}
