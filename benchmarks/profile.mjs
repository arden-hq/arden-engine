import { Schema } from "effect"
import { readFile } from "node:fs/promises"

const positive = Schema.Int.check(Schema.isGreaterThan(0))
export const ProfileSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  provider: Schema.optionalKey(Schema.Literals(["responses", "codex"])),
  accountIdEnv: Schema.optionalKey(Schema.NonEmptyString),
  baseUrl: Schema.NonEmptyString,
  apiKeyEnv: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  reasoningEffort: Schema.NullOr(Schema.NonEmptyString),
  contextLimit: positive,
  timeoutMs: positive,
  maxModelRequests: positive,
  tools: Schema.Array(Schema.NonEmptyString).check(Schema.isUnique()),
  memory: Schema.Boolean,
  /**
   * `true` keeps the route's client-side tool search, as in the app, so the
   * model searches for deferred tools. Absent or `false`: every allowed tool is
   * declared up front, as other harnesses present a benchmark's tools.
   */
  toolSearch: Schema.optionalKey(Schema.Boolean),
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
  if (profile.model === "REPLACE_WITH_MODEL_ID") throw new Error("Choose a model before running")
  return profile
}
export function modelHost(profile) {
  const inherit = { modelId: null, reasoningEffort: null }
  return {
    models: [
      {
        id: profile.model,
        name: profile.model,
        provider:
          profile.provider === "codex"
            ? { id: "openai-codex", name: "OpenAI Codex" }
            : { id: "benchmark-responses", name: "Benchmark Responses" },
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
