import type { ModelProviderOptions } from "../config/options.js"
import type { ModelDefinition, ModelHost } from "../models/host.js"
import {
  detectServer,
  discoverLlamaCpp,
  discoverOpenRouter,
  DiscoveryError,
  UnreachableError,
  CHAT_COMPLETIONS_SERVER,
  type ChatCompletionsServer,
  type DiscoveredModel,
  type DiscoveryInput
} from "../providers/chat-completions/discovery.js"
import {
  CHAT_COMPLETIONS_HOSTS,
  chatCompletionsDefinition,
  chatCompletionsProvider,
  connectionOf,
  contextOf,
  declaredModel,
  discoveryInput
} from "../providers/chat-completions/route.js"
import { CodexLoginError, signedInCredentials } from "../providers/openai-codex/cli-login.js"
import { makeOpenAiCodexRuntime } from "../providers/openai-codex/runtime.js"
import {
  makeOpenAiResponsesProvider,
  type OpenAiCredentialSnapshot,
  type OpenAiCredentialSource
} from "../providers/openai-responses/provider.js"
import { requireServerFields, SERVE_PROVIDER, SettingsError, type Settings } from "./settings.js"

export class ProviderUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderUnreachableError"
  }
}

const discoveryFailure = (baseUrl: string, cause: unknown): unknown => {
  if (cause instanceof UnreachableError)
    return new ProviderUnreachableError(
      `The model server at ${baseUrl} (\`provider.baseUrl\`) did not answer: ${cause.message}`
    )
  if (cause instanceof DiscoveryError) return new SettingsError(cause.message)
  return cause
}

const DISCOVERY_TIMEOUT_MS = 15_000

const inherit = { modelId: null, reasoningEffort: null }

type Provider = NonNullable<Settings["provider"]>
type ChatCompletionsProvider = Extract<Provider, { readonly kind: "chat-completions" }>

type EnvField = "apiKeyEnv" | "accessTokenEnv" | "accountIdEnv"

const fromEnv = (env: NodeJS.ProcessEnv, field: EnvField, name: string): string => {
  const value = env[name]
  if (value === undefined || value.length === 0)
    throw new SettingsError(`Missing environment variable ${name}, named by \`provider.${field}\``)
  return value
}

const hostOf = (
  settings: Settings,
  chat: ModelDefinition,
  extra: ReadonlyArray<ModelDefinition>
): ModelHost => {
  const effort = settings.reasoningEffort
  if (effort !== undefined && !chat.reasoningEfforts.includes(effort))
    throw new SettingsError(`Reasoning effort is unavailable for ${chat.id}: ${effort}`)
  return {
    models: [chat, ...extra],
    defaults: {
      chatModelId: chat.id,
      reasoningEfforts: effort === undefined ? {} : { [chat.id]: effort },
      roles: {
        background:
          settings.backgroundModel === undefined
            ? inherit
            : { modelId: settings.backgroundModel, reasoningEffort: null },
        helper:
          settings.helperModel === undefined
            ? inherit
            : { modelId: settings.helperModel, reasoningEffort: null }
      }
    }
  }
}

const loweredLimit = (settings: Settings, own: number): number => {
  const limit = settings.contextLimit
  if (limit !== undefined && limit > own)
    throw new SettingsError(`contextLimit ${limit} is above the model's own ${own}`)
  return limit ?? own
}

const declaredEfforts = (settings: Settings): ReadonlyArray<string> =>
  settings.reasoningEffort === undefined ? [] : [settings.reasoningEffort]

const responsesModels = (settings: Settings): ModelHost => {
  const limit = settings.contextLimit as number
  const entry = (id: string): ModelDefinition => ({
    id,
    name: id,
    provider: { id: "responses", name: "Responses API" },
    reasoningEfforts: declaredEfforts(settings),
    context: contextOf(limit)
  })
  return hostOf(settings, entry(settings.model as string), (settings.extraModels ?? []).map(entry))
}

const codexModels = (settings: Settings, live: ModelHost): ModelHost => {
  if (settings.model === undefined) return live
  const find = (id: string): ModelDefinition => {
    const model = live.models.find((entry) => entry.id === id)
    if (model === undefined)
      throw new SettingsError(`Model is unavailable in the Codex account: ${id}`)
    return model
  }
  const chat = find(settings.model)
  return hostOf(
    settings,
    { ...chat, context: contextOf(loweredLimit(settings, chat.context.hardLimit)) },
    (settings.extraModels ?? []).map(find)
  )
}

const discoverModels = async (
  settings: Settings,
  server: ChatCompletionsServer,
  input: DiscoveryInput
): Promise<ReadonlyArray<DiscoveredModel>> => {
  const wanted =
    settings.model === undefined ? undefined : [settings.model, ...(settings.extraModels ?? [])]
  try {
    switch (server) {
      case CHAT_COMPLETIONS_SERVER.llamaCpp:
        return await discoverLlamaCpp(input, wanted)
      case CHAT_COMPLETIONS_SERVER.openrouter:
        return await discoverOpenRouter(input, wanted ?? [])
      case CHAT_COMPLETIONS_SERVER.generic:
        return (wanted ?? []).map((id) =>
          declaredModel({
            id,
            contextLimit: settings.contextLimit,
            reasoningEfforts: declaredEfforts(settings)
          })
        )
    }
  } catch (cause) {
    throw discoveryFailure(input.baseUrl, cause)
  }
}

const definitionFor = (
  settings: Settings,
  server: ChatCompletionsServer,
  model: DiscoveredModel,
  isChat: boolean
): ModelDefinition => {
  const host = CHAT_COMPLETIONS_HOSTS[server]
  const window = (own: number | undefined): number | undefined => {
    if (!isChat) return own
    if (own === undefined) return settings.contextLimit
    return loweredLimit(settings, own)
  }
  const limit = window(model.contextLimit)
  if (limit === undefined)
    throw new SettingsError(
      `${host.name} does not report the context window of ${model.id}; set \`contextLimit\``
    )
  return chatCompletionsDefinition({ group: host, model, window: limit })
}

const chatCompletionsRoute = async (
  settings: Settings,
  provider: ChatCompletionsProvider,
  { env, fetch }: ModelsForOptions
): Promise<ModelProviderOptions> => {
  const connection = connectionOf({
    baseUrl: provider.baseUrl,
    key:
      provider.apiKeyEnv === undefined ? undefined : fromEnv(env, "apiKeyEnv", provider.apiKeyEnv),
    fetch
  })
  const input = discoveryInput(connection, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS))
  const server = provider.server ?? (await detected(input))
  requireServerFields(settings, server)
  const [chat, ...extra] = await discoverModels(settings, server, input)
  if (chat === undefined) throw new Error("Discovery answered no model")
  return {
    provider: chatCompletionsProvider({
      connection,
      providerId: CHAT_COMPLETIONS_HOSTS[server].id,
      models: [chat, ...extra]
    }),
    modelHost: hostOf(
      settings,
      definitionFor(settings, server, chat, true),
      extra.map((model) => definitionFor(settings, server, model, false))
    )
  }
}

const detected = async (input: DiscoveryInput): Promise<ChatCompletionsServer> => {
  try {
    return await detectServer(input)
  } catch (cause) {
    throw discoveryFailure(input.baseUrl, cause)
  }
}

export interface ModelsForOptions {
  readonly env: NodeJS.ProcessEnv
  readonly fetch: typeof globalThis.fetch
}

export const modelsFor = async (
  settings: Settings,
  options: ModelsForOptions
): Promise<ModelProviderOptions> => {
  const provider = settings.provider ?? { kind: SERVE_PROVIDER.codexLogin }
  if (provider.kind === SERVE_PROVIDER.chatCompletions)
    return chatCompletionsRoute(settings, provider, options)
  const env = options.env
  if (provider.kind === SERVE_PROVIDER.responses) {
    const credential = { accessToken: fromEnv(env, "apiKeyEnv", provider.apiKeyEnv) }
    return {
      provider: makeOpenAiResponsesProvider({
        baseUrl: provider.baseUrl,
        credentials: { get: async () => credential }
      }),
      modelHost: responsesModels(settings)
    }
  }
  let credentials: OpenAiCredentialSource
  let initialCredential: OpenAiCredentialSnapshot
  if (provider.kind === SERVE_PROVIDER.codex) {
    const account =
      provider.accountIdEnv === undefined
        ? undefined
        : fromEnv(env, "accountIdEnv", provider.accountIdEnv)
    initialCredential = {
      accessToken: fromEnv(env, "accessTokenEnv", provider.accessTokenEnv),
      ...(account === undefined ? {} : { headers: { "chatgpt-account-id": account } })
    }
    const fixed = initialCredential
    credentials = { get: async () => fixed }
  } else {
    credentials = signedInCredentials({ env })
    try {
      initialCredential = await credentials.get({ signal: AbortSignal.timeout(5_000) })
    } catch (cause) {
      if (cause instanceof CodexLoginError)
        throw new SettingsError(
          `No ChatGPT sign-in on this machine (run \`arden login\`): ${cause.message}`
        )
      throw cause
    }
  }
  const runtime = await makeOpenAiCodexRuntime({ credentials, initialCredential })
  if (runtime === null) throw new SettingsError("Codex account authentication failed")
  return {
    provider: runtime.provider,
    modelHost: codexModels(settings, runtime.modelHost),
    approvalReview: runtime.approvalReview,
    planLimits: runtime.planLimits,
    transcription: runtime.transcription,
    ...(settings.model === undefined ? { refreshModelHost: runtime.refreshModelHost } : {})
  }
}
