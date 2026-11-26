import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { CHAT_COMPLETIONS_SERVERS } from "../apps/server-ts/dist/providers/chat-completions/discovery.js"
import { parseSettings, SERVE_PROVIDER } from "../apps/server-ts/dist/serve/settings.js"
import { parseJsonText } from "../libs/std/dist/json-text.js"

const PLACEHOLDER_MODEL = "REPLACE_WITH_MODEL_ID"

const positive = Schema.Int.check(Schema.isGreaterThan(0))
const names = Schema.Array(Schema.NonEmptyString).check(Schema.isUnique())
export const ProfileSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  provider: Schema.optionalKey(
    Schema.Literals([
      SERVE_PROVIDER.responses,
      SERVE_PROVIDER.codex,
      SERVE_PROVIDER.chatCompletions
    ])
  ),
  accountIdEnv: Schema.optionalKey(Schema.NonEmptyString),
  server: Schema.optionalKey(Schema.Literals(CHAT_COMPLETIONS_SERVERS)),
  baseUrl: Schema.NonEmptyString,
  apiKeyEnv: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.NonEmptyString,
  reasoningEffort: Schema.NullOr(Schema.NonEmptyString),
  contextLimit: positive,
  timeoutMs: positive,
  maxModelRequests: positive,
  extraModels: Schema.optionalKey(names),
  tools: Schema.optionalKey(names),
  blockedTools: Schema.optionalKey(Schema.Struct({ sources: names, tools: names })),
  memory: Schema.Boolean,
  toolSearch: Schema.optionalKey(Schema.Boolean),
  commandSandbox: Schema.optionalKey(Schema.Boolean),
  mcpServers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        command: Schema.NonEmptyString,
        args: Schema.Array(Schema.String),
        cwd: Schema.NonEmptyString,
        environment: Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString)
      })
    )
  )
})
export async function readProfile(filename) {
  const raw = parseJsonText(await readFile(filename, "utf8"))
  const profile = Schema.decodeUnknownSync(ProfileSchema)(raw, { onExcessProperty: "error" })
  if (profile.server !== undefined && profile.provider !== SERVE_PROVIDER.chatCompletions)
    throw new Error("`server` belongs to a chat-completions provider")
  try {
    parseSettings({ dataDirectory: "/profile-check", ...modelSettings(profile) })
  } catch (error) {
    throw new Error(`Profile ${filename}: ${error.message}`, { cause: error })
  }
  if (new URL(profile.baseUrl).search) throw new Error("Provider URL must not contain a query")
  if ((profile.tools === undefined) === (profile.blockedTools === undefined))
    throw new Error("Profile needs exactly one of `tools` and `blockedTools`")
  if (profile.model === PLACEHOLDER_MODEL) throw new Error("Choose a model before running")
  return profile
}
export function modelSettings(profile) {
  return {
    provider: providerSettings(profile),
    model: profile.model,
    ...(profile.reasoningEffort === null ? {} : { reasoningEffort: profile.reasoningEffort }),
    contextLimit: profile.contextLimit,
    ...(profile.extraModels ? { extraModels: profile.extraModels } : {})
  }
}
function providerSettings(profile) {
  switch (profile.provider ?? SERVE_PROVIDER.responses) {
    case SERVE_PROVIDER.codex:
      return {
        kind: SERVE_PROVIDER.codex,
        accessTokenEnv: profile.apiKeyEnv,
        ...(profile.accountIdEnv ? { accountIdEnv: profile.accountIdEnv } : {})
      }
    case SERVE_PROVIDER.chatCompletions:
      return {
        kind: SERVE_PROVIDER.chatCompletions,
        baseUrl: profile.baseUrl,
        ...(profile.apiKeyEnv ? { apiKeyEnv: profile.apiKeyEnv } : {}),
        ...(profile.server ? { server: profile.server } : {})
      }
    case SERVE_PROVIDER.responses:
      return {
        kind: SERVE_PROVIDER.responses,
        baseUrl: profile.baseUrl,
        apiKeyEnv: profile.apiKeyEnv
      }
  }
}

const HOSTS = {
  [SERVE_PROVIDER.responses]: { id: "benchmark-responses", name: "Benchmark Responses" },
  [SERVE_PROVIDER.codex]: { id: "openai-codex", name: "OpenAI Codex" },
  [SERVE_PROVIDER.chatCompletions]: {
    id: "benchmark-chat-completions",
    name: "Benchmark Chat Completions"
  }
}

export function modelHost(profile) {
  const inherit = { modelId: null, reasoningEffort: null }
  return {
    models: [
      {
        id: profile.model,
        name: profile.model,
        provider: HOSTS[profile.provider ?? SERVE_PROVIDER.responses],
        reasoningEfforts: profile.reasoningEffort === null ? [] : [profile.reasoningEffort],
        context: {
          hardLimit: profile.contextLimit,
          compactionTrigger: Math.floor(profile.contextLimit * 0.8)
        }
      }
    ],
    defaults: {
      chatModelId: profile.model,
      reasoningEfforts:
        profile.reasoningEffort === null ? {} : { [profile.model]: profile.reasoningEffort },
      roles: { background: inherit, helper: inherit }
    }
  }
}
