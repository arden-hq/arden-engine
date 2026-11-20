import type { ModelProviderOptions } from "../config/options.js"
import type { ModelDefinition, ModelHost } from "../models/host.js"
import {
  detectServer,
  discoverLlamaCpp,
  discoverOpenRouter,
  DiscoveryError,
  UnreachableError,
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
import { requireServerFields, SettingsError, type Settings } from "./settings.js"

/**
 * The model server named by `provider.baseUrl` did not answer at start: it is
 * not running, or not at that address. Not a `SettingsError`: the file may be
 * right. A configured server exits with `CONFIGURED_SERVER_EXIT.providerUnreachable`.
 */
export class ProviderUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderUnreachableError"
  }
}

/** Discovery's failures in the settings' words: which field to fix, or which server to start. */
const discoveryFailure = (baseUrl: string, cause: unknown): unknown => {
  if (cause instanceof UnreachableError)
    return new ProviderUnreachableError(
      `The model server at ${baseUrl} (\`provider.baseUrl\`) did not answer: ${cause.message}`
    )
  if (cause instanceof DiscoveryError) return new SettingsError(cause.message)
  return cause
}

/** How long start may wait for a Chat Completions server to describe its models. */
const DISCOVERY_TIMEOUT_MS = 15_000

const inherit = { modelId: null, reasoningEffort: null }

type Provider = NonNullable<Settings["provider"]>
type ChatCompletionsProvider = Extract<Provider, { readonly kind: "chat-completions" }>

/** The settings fields that name an environment variable. */
type EnvField = "apiKeyEnv" | "accessTokenEnv" | "accountIdEnv"

/** The variable `provider[field]` names; its absence names the field, which is what to fix. */
const fromEnv = (env: NodeJS.ProcessEnv, field: EnvField, name: string): string => {
  const value = env[name]
  if (value === undefined || value.length === 0)
    throw new SettingsError(`Missing environment variable ${name}, named by \`provider.${field}\``)
  return value
}

/** The models a configured server lists: `model` first, then `extraModels`. */
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

/**
 * The chat model's window: the provider's own, lowered by `contextLimit`.
 * Raising it would only move the overflow from the settings to a request.
 */
const loweredLimit = (settings: Settings, own: number): number => {
  const limit = settings.contextLimit
  if (limit !== undefined && limit > own)
    throw new SettingsError(`contextLimit ${limit} is above the model's own ${own}`)
  return limit ?? own
}

/** What the settings say a model without a catalog can do: the effort they name, if any. */
const declaredEfforts = (settings: Settings): ReadonlyArray<string> =>
  settings.reasoningEffort === undefined ? [] : [settings.reasoningEffort]

const responsesModels = (settings: Settings): ModelHost => {
  // parseSettings requires both for this provider.
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

/** A Codex catalog cut down to the settings' models, with the context limit lowered if asked. */
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

/**
 * The settings' models as their server reports them, `model` first. A generic
 * server reports nothing, so its models are what the settings say.
 */
const discoverModels = async (
  settings: Settings,
  server: ChatCompletionsServer,
  input: DiscoveryInput
): Promise<ReadonlyArray<DiscoveredModel>> => {
  const wanted =
    settings.model === undefined ? undefined : [settings.model, ...(settings.extraModels ?? [])]
  try {
    switch (server) {
      case "llama.cpp":
        return await discoverLlamaCpp(input, wanted)
      case "openrouter":
        // requireServerFields: OpenRouter needs `model`.
        return await discoverOpenRouter(input, wanted ?? [])
      case "generic":
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
  // `contextLimit` is the chat model's, as for Codex: it lowers what the
  // server reports, or stands alone where the server reports nothing.
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
  /** Where the provider's `apiKeyEnv` and Codex variables are read. */
  readonly env: NodeJS.ProcessEnv
  /** Transport for discovery and model requests of a `chat-completions` provider. */
  readonly fetch: typeof globalThis.fetch
}

/** The provider and model list a configured server starts with. */
export const modelsFor = async (
  settings: Settings,
  options: ModelsForOptions
): Promise<ModelProviderOptions> => {
  const provider = settings.provider ?? { kind: "codex-login" as const }
  if (provider.kind === "chat-completions") return chatCompletionsRoute(settings, provider, options)
  const env = options.env
  if (provider.kind === "responses") {
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
  if (provider.kind === "codex") {
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
        throw new SettingsError(`No ChatGPT sign-in on this machine (run \`arden login\`): ${cause.message}`)
      throw cause
    }
  }
  // No base URL: Codex credentials go only to the runtime's own official endpoint.
  const runtime = await makeOpenAiCodexRuntime({ credentials, initialCredential })
  if (runtime === null) throw new SettingsError("Codex account authentication failed")
  return {
    provider: runtime.provider,
    modelHost: codexModels(settings, runtime.modelHost),
    approvalReview: runtime.approvalReview,
    planLimits: runtime.planLimits,
    transcription: runtime.transcription,
    // A cut-down list stays as cut; the full one follows the account.
    ...(settings.model === undefined ? { refreshModelHost: runtime.refreshModelHost } : {})
  }
}
