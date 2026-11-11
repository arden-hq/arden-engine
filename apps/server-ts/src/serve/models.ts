import type { ModelProviderOptions } from "../config/options.js"
import type { ModelDefinition, ModelHost } from "../models/host.js"
import { codexCliCredentials, CodexLoginError } from "../providers/openai-codex/cli-login.js"
import { makeOpenAiCodexRuntime } from "../providers/openai-codex/runtime.js"
import {
  makeOpenAiResponsesProvider,
  type OpenAiCredentialSnapshot,
  type OpenAiCredentialSource
} from "../providers/openai-responses/provider.js"
import { SettingsError, type Settings } from "./settings.js"

const COMPACTION_SHARE = 0.8

const inherit = { modelId: null, reasoningEffort: null }

const fromEnv = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (value === undefined || value.length === 0)
    throw new SettingsError(`Missing environment variable ${name}`)
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

const responsesModels = (settings: Settings): ModelHost => {
  // parseSettings requires both for this provider.
  const limit = settings.contextLimit as number
  const entry = (id: string): ModelDefinition => ({
    id,
    name: id,
    provider: { id: "responses", name: "Responses API" },
    reasoningEfforts: settings.reasoningEffort === undefined ? [] : [settings.reasoningEffort],
    context: { hardLimit: limit, compactionTrigger: Math.floor(limit * COMPACTION_SHARE) }
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
  const limit = settings.contextLimit
  if (limit !== undefined && limit > chat.context.hardLimit)
    throw new SettingsError(
      `contextLimit ${limit} is above the model's own ${chat.context.hardLimit}`
    )
  return hostOf(
    settings,
    limit === undefined
      ? chat
      : {
          ...chat,
          context: { hardLimit: limit, compactionTrigger: Math.floor(limit * COMPACTION_SHARE) }
        },
    (settings.extraModels ?? []).map(find)
  )
}

/** The provider and model list a configured server starts with. */
export const modelsFor = async (
  settings: Settings,
  env: NodeJS.ProcessEnv
): Promise<ModelProviderOptions> => {
  const provider = settings.provider ?? { kind: "codex-login" as const }
  if (provider.kind === "responses") {
    const credential = { accessToken: fromEnv(env, provider.apiKeyEnv) }
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
      provider.accountIdEnv === undefined ? undefined : fromEnv(env, provider.accountIdEnv)
    initialCredential = {
      accessToken: fromEnv(env, provider.accessTokenEnv),
      ...(account === undefined ? {} : { headers: { "chatgpt-account-id": account } })
    }
    const fixed = initialCredential
    credentials = { get: async () => fixed }
  } else {
    credentials = codexCliCredentials({ env })
    try {
      initialCredential = await credentials.get({ signal: AbortSignal.timeout(5_000) })
    } catch (cause) {
      if (cause instanceof CodexLoginError)
        throw new SettingsError(`No Codex sign-in on this machine: ${cause.message}`)
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
