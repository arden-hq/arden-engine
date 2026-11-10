import { makeOpenAiResponsesProvider } from "../apps/server-ts/dist/providers/openai-responses/provider.js"
import { makeOpenAiCodexRuntime } from "../apps/server-ts/dist/providers/openai-codex/runtime.js"

export async function benchmarkProvider(profile) {
  const accessToken = process.env[profile.apiKeyEnv]
  if (!accessToken) throw new Error(`Missing credential environment variable ${profile.apiKeyEnv}`)
  const headers = profile.accountIdEnv
    ? { "chatgpt-account-id": process.env[profile.accountIdEnv] }
    : undefined
  if (headers && !headers["chatgpt-account-id"]) throw new Error("Missing Codex account identity")
  const credential = { accessToken, ...(headers ? { headers } : {}) }
  const credentials = { get: async () => credential }
  if (profile.provider !== "codex") {
    return {
      provider: makeOpenAiResponsesProvider({ baseUrl: profile.baseUrl, credentials }),
      catalog: null
    }
  }
  // No baseUrl: the runtime's own official endpoint is the only place Codex credentials go.
  const runtime = await makeOpenAiCodexRuntime({ credentials, initialCredential: credential })
  if (!runtime) throw new Error("Codex account authentication failed")
  const model = runtime.modelHost.models.find((entry) => entry.id === profile.model)
  if (!model)
    throw new Error(`Requested model is unavailable in the Codex account: ${profile.model}`)
  if (profile.reasoningEffort && !model.reasoningEfforts.includes(profile.reasoningEffort)) {
    throw new Error(`Requested reasoning effort is unavailable: ${profile.reasoningEffort}`)
  }
  if (profile.contextLimit > model.context.hardLimit)
    throw new Error("Profile context exceeds the live Codex limit")
  return { provider: runtime.provider, catalog: model }
}
