import { Schema } from "effect"
import { readFile } from "node:fs/promises"

const positive = Schema.Int.check(Schema.isGreaterThan(0))
const names = Schema.Array(Schema.NonEmptyString).check(Schema.isUnique())
export const ProfileSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  /** Arden's provider kind; absent is `responses`. */
  provider: Schema.optionalKey(Schema.Literals(["responses", "codex", "chat-completions"])),
  accountIdEnv: Schema.optionalKey(Schema.NonEmptyString),
  /** A `chat-completions` provider's server, when detection should not decide (see the server README). */
  server: Schema.optionalKey(Schema.Literals(["llama.cpp", "openrouter", "generic"])),
  baseUrl: Schema.NonEmptyString,
  apiKeyEnv: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  reasoningEffort: Schema.NullOr(Schema.NonEmptyString),
  contextLimit: positive,
  timeoutMs: positive,
  maxModelRequests: positive,
  /**
   * More models the trial lists beside `model`, so the main model can give one
   * to a sub-agent. Absent: the trial lists `model` only and every sub-agent
   * runs on it.
   */
  extraModels: Schema.optionalKey(names),
  /** Allow-list: the model is offered only these tools. Give this or `blockedTools`. */
  tools: Schema.optionalKey(names),
  /**
   * Block-list: the model is offered every tool in the server's catalog except
   * these. `sources` hides a whole group by the catalog's `source` (for
   * example `gmail`, `_browser`); `tools` hides single tools by name.
   */
  blockedTools: Schema.optionalKey(Schema.Struct({ sources: names, tools: names })),
  memory: Schema.Boolean,
  /**
   * `true` keeps the route's client-side tool search, as in the app, so the
   * model searches for deferred tools. Absent or `false`: every allowed tool is
   * declared up front, as other harnesses present a benchmark's tools.
   */
  toolSearch: Schema.optionalKey(Schema.Boolean),
  /**
   * `false` runs every shell command without Arden's own sandbox, for a trial
   * that already sits in a throwaway container. Other harnesses run these
   * benchmarks the same way. Absent or `true`: the sandbox stays on.
   */
  commandSandbox: Schema.optionalKey(Schema.Boolean),
  /** Benchmark-owned stdio MCP servers; `environment` maps a server variable to a host variable name. */
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
  const raw = JSON.parse(await readFile(filename, "utf8"))
  const profile = Schema.decodeUnknownSync(ProfileSchema)(raw, { onExcessProperty: "error" })
  const url = new URL(profile.baseUrl)
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("Provider URL must use HTTPS or loopback HTTP")
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Provider URL must not contain credentials, query, or fragment")
  if ((profile.tools === undefined) === (profile.blockedTools === undefined))
    throw new Error("Profile needs exactly one of `tools` and `blockedTools`")
  if (profile.model === "REPLACE_WITH_MODEL_ID") throw new Error("Choose a model before running")
  if (profile.server !== undefined && profile.provider !== "chat-completions")
    throw new Error("`server` belongs to a chat-completions provider")
  return profile
}
/**
 * The profile's provider and model as Arden's settings file names them. The
 * key is not in it: the settings name the variable that holds it.
 */
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
  switch (profile.provider ?? "responses") {
    case "codex":
      return {
        kind: "codex",
        accessTokenEnv: profile.apiKeyEnv,
        ...(profile.accountIdEnv ? { accountIdEnv: profile.accountIdEnv } : {})
      }
    case "chat-completions":
      return {
        kind: "chat-completions",
        baseUrl: profile.baseUrl,
        apiKeyEnv: profile.apiKeyEnv,
        ...(profile.server ? { server: profile.server } : {})
      }
    case "responses":
      return { kind: "responses", baseUrl: profile.baseUrl, apiKeyEnv: profile.apiKeyEnv }
  }
}

/** How the model list names each provider kind before the server starts. */
const HOSTS = {
  responses: { id: "benchmark-responses", name: "Benchmark Responses" },
  codex: { id: "openai-codex", name: "OpenAI Codex" },
  "chat-completions": { id: "benchmark-chat-completions", name: "Benchmark Chat Completions" }
}

/** The model list history import writes its chats under, before the server starts. */
export function modelHost(profile) {
  const inherit = { modelId: null, reasoningEffort: null }
  return {
    models: [
      {
        id: profile.model,
        name: profile.model,
        provider: HOSTS[profile.provider ?? "responses"],
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
