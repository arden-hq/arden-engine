import { errorMessage } from "@arden-hq/std/errors"
import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"

const text = Schema.String.check(Schema.isMinLength(1))
const positive = Schema.Int.check(Schema.isGreaterThan(0))
const names = Schema.Array(text).check(Schema.isUnique())
const absolute = text.check(
  Schema.makeFilter((path) => (isAbsolute(path) ? undefined : "must be an absolute path"))
)

/**
 * Where the model comes from. The key itself is never in the file: a provider
 * names the environment variable that holds it.
 */
const ProviderSchema = Schema.Union([
  /** Any endpoint that speaks the OpenAI Responses API. */
  Schema.Struct({
    kind: Schema.Literal("responses"),
    baseUrl: text,
    apiKeyEnv: text
  }),
  /** A Codex account, with the token passed in by the caller. */
  Schema.Struct({
    kind: Schema.Literal("codex"),
    accessTokenEnv: text,
    accountIdEnv: Schema.optionalKey(text)
  }),
  /** The Codex sign-in on this machine (`codex login`). The default. */
  Schema.Struct({ kind: Schema.Literal("codex-login") })
])

const McpServerSchema = Schema.Struct({
  name: text,
  command: text,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(text),
  /** Maps a variable the MCP server reads to the caller's variable that holds the value. */
  environment: Schema.optionalKey(Schema.Record(text, text))
})

/**
 * Everything a configured start (`--config <file>`) applies before the first
 * message. Only `dataDirectory` is required; an absent field keeps the
 * server's own default.
 */
export const SettingsSchema = Schema.Struct({
  /** Folder for the database and Arden's other files. Never the default
   *  `~/.arden`, so a configured server cannot change the owner's own data. */
  dataDirectory: absolute,
  /** Loopback port; absent or 0 picks a free one. */
  port: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65535))
  ),
  provider: Schema.optionalKey(ProviderSchema),
  /** The chat model. Required for a `responses` provider, which has no catalog.
   *  When given, the server lists only this model and `extraModels`. */
  model: Schema.optionalKey(text),
  reasoningEffort: Schema.optionalKey(text),
  /** Context window in tokens. Required for a `responses` provider; for a
   *  Codex model it may only lower the model's own limit. */
  contextLimit: Schema.optionalKey(positive),
  /** More models listed beside `model`, for the main model to give a sub-agent. */
  extraModels: Schema.optionalKey(names),
  /** Most model steps one run may take. */
  maxSteps: Schema.optionalKey(positive),
  /** Allow-list: the model is offered only these tools. At most one of this and `blockedTools`. */
  tools: Schema.optionalKey(names),
  /** Block-list: every tool is offered except these `sources` (whole groups) and `tools` (names). */
  blockedTools: Schema.optionalKey(Schema.Struct({ sources: names, tools: names })),
  /** The one folder file tools may change. */
  workspace: Schema.optionalKey(absolute),
  /** False keeps Memory recall and related chats out of every prompt. */
  memory: Schema.optionalKey(Schema.Boolean),
  /** False turns every Automation off, built-in ones included. */
  automations: Schema.optionalKey(Schema.Boolean),
  mcpServers: Schema.optionalKey(Schema.Array(McpServerSchema)),
  /** Read-only Skill folders; `[]` reads none beside Arden's own. */
  skillRoots: Schema.optionalKey(Schema.Array(absolute)),
  /** False runs shell commands without Arden's sandbox, for a throwaway container. */
  commandSandbox: Schema.optionalKey(Schema.Boolean),
  /** Idle-compaction delay; 0 compacts only when the context fills. */
  idleCompactionAfterMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

export type Settings = typeof SettingsSchema.Type
export type ProviderSettings = typeof ProviderSchema.Type

/** A settings file the caller can fix: the message says which field and why. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsError"
  }
}

const decode = Schema.decodeUnknownSync(SettingsSchema)

export const parseSettings = (value: unknown): Settings => {
  let settings: Settings
  try {
    settings = decode(value, { onExcessProperty: "error" })
  } catch (cause) {
    throw new SettingsError(`Invalid settings: ${errorMessage(cause)}`)
  }
  if (settings.tools !== undefined && settings.blockedTools !== undefined)
    throw new SettingsError("Invalid settings: give `tools` or `blockedTools`, not both")
  if (settings.extraModels !== undefined && settings.model === undefined)
    throw new SettingsError("Invalid settings: `extraModels` needs `model`")
  if (settings.model !== undefined && settings.extraModels?.includes(settings.model))
    throw new SettingsError("Invalid settings: `extraModels` repeats `model`")
  if (settings.provider?.kind === "responses") {
    if (settings.model === undefined || settings.contextLimit === undefined)
      throw new SettingsError(
        "Invalid settings: a `responses` provider needs `model` and `contextLimit`"
      )
  }
  return settings
}

export const readSettings = async (path: string): Promise<Settings> => {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    throw new SettingsError(`Cannot read the settings file: ${path}`)
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new SettingsError(`The settings file is not JSON: ${path}`)
  }
  return parseSettings(value)
}
