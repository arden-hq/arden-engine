import {
  resolveModelCapabilities,
  type ModelProvider,
  MODEL_PROVIDER_PROTOCOL
} from "@arden-hq/loop"
import { ProviderError } from "@arden-hq/loop/provider-kit"
import { makeChatCompletionsProvider } from "@arden-hq/loop/providers/chat-completions"
import type { ModelDefinition } from "../../models/host.js"
import type { ChatCompletionsServer, DiscoveredModel, DiscoveryInput } from "./discovery.js"

const COMPACTION_SHARE = 0.8

export const CHAT_COMPLETIONS_HOSTS: Record<ChatCompletionsServer, ModelDefinition["provider"]> = {
  "llama.cpp": { id: "llama.cpp", name: "llama.cpp" },
  openrouter: { id: "openrouter", name: "OpenRouter" },
  generic: { id: "chat-completions", name: "Chat Completions" }
}

export interface ChatCompletionsConnection {
  readonly baseUrl: string
  readonly key: string | undefined
  readonly fetch: typeof globalThis.fetch
}

export const connectionOf = (input: {
  readonly baseUrl: string
  readonly key: string | undefined
  readonly fetch: typeof globalThis.fetch
}): ChatCompletionsConnection => ({
  baseUrl: input.baseUrl.replace(/\/+$/, ""),
  key: input.key,
  fetch: input.fetch
})

const headersOf = (connection: ChatCompletionsConnection): Record<string, string> =>
  connection.key === undefined ? {} : { authorization: `Bearer ${connection.key}` }

export const discoveryInput = (
  connection: ChatCompletionsConnection,
  signal: AbortSignal
): DiscoveryInput => ({
  baseUrl: connection.baseUrl,
  fetch: connection.fetch,
  headers: headersOf(connection),
  signal
})

export const declaredModel = (input: {
  readonly id: string
  readonly contextLimit: number | undefined
  readonly reasoningEfforts: ReadonlyArray<string>
}): DiscoveredModel => ({
  id: input.id,
  contextLimit: input.contextLimit,
  outputCap: undefined,
  reasoningEfforts: input.reasoningEfforts,
  compat: {}
})

export const contextOf = (limit: number): ModelDefinition["context"] => ({
  hardLimit: limit,
  compactionTrigger: Math.floor(limit * COMPACTION_SHARE)
})

export const chatCompletionsDefinition = (input: {
  readonly group: ModelDefinition["provider"]
  readonly model: DiscoveredModel
  readonly window: number
}): ModelDefinition => ({
  id: input.model.id,
  name: input.model.id,
  provider: input.group,
  reasoningEfforts: input.model.reasoningEfforts,
  context: {
    ...contextOf(input.window),
    ...(input.model.outputCap === undefined ? {} : { outputCap: input.model.outputCap })
  }
})

export const chatCompletionsProvider = (input: {
  readonly connection: ChatCompletionsConnection
  readonly providerId: string
  readonly models: ReadonlyArray<DiscoveredModel>
}): ModelProvider => {
  const { connection } = input
  const headers = headersOf(connection)
  const providers = new Map(
    input.models.map((model) => [
      model.id,
      makeChatCompletionsProvider({
        providerId: input.providerId,
        baseUrl: connection.baseUrl,
        fetch: connection.fetch,
        ...(connection.key === undefined ? {} : { auth: { headers: async () => headers } }),
        compat: model.compat
      })
    ])
  )
  const pick = (model: string): ModelProvider => {
    const provider = providers.get(model)
    if (provider === undefined)
      throw new ProviderError(`No Chat Completions route for model ${model}`, {
        code: "model_unavailable",
        retryable: false
      })
    return provider
  }
  return {
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    capabilities: (model) => resolveModelCapabilities({ provider: pick(model), model }),
    stream: (request) => pick(request.model).stream(request)
  }
}
