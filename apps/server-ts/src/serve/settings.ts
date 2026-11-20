import { APPROVAL_MODES } from "@arden-hq/protocol/permissions"
import { errorMessage } from "@arden-hq/std/errors"
import { baseUrlIssue, type BaseUrlIssue } from "@arden-hq/std/url"
import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import {
  CHAT_COMPLETIONS_SERVERS,
  type ChatCompletionsServer
} from "../providers/chat-completions/discovery.js"

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
  /**
   * Any endpoint that speaks the OpenAI Chat Completions API: llama.cpp's
   * `llama-server`, OpenRouter, or another. A local server needs no key.
   * `server` says which, for what it can tell about a model; absent, it is
   * detected at start (`detectServer`). `llama.cpp` and `openrouter` report
   * the window and what the model can do; `generic` needs `model` and
   * `contextLimit`.
   */
  Schema.Struct({
    kind: Schema.Literal("chat-completions"),
    baseUrl: text,
    apiKeyEnv: Schema.optionalKey(text),
    server: Schema.optionalKey(Schema.Literals(CHAT_COMPLETIONS_SERVERS))
  }),
  /** The ChatGPT sign-in on this machine: `arden login`, else `codex login`. The default. */
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
const SettingsSchema = Schema.Struct({
  /** Folder for the database and Arden's other files. Never the default
   *  `~/.arden`, so a configured server cannot change the owner's own data. */
  dataDirectory: absolute,
  /** Loopback port; absent or 0 picks a free one. */
  port: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65535))
  ),
  provider: Schema.optionalKey(ProviderSchema),
  /** The chat model. Required for a `responses` provider, which has no catalog,
   *  and for a `chat-completions` one on OpenRouter or a generic server. A
   *  llama.cpp server with one model may leave it out. When given, the server
   *  lists only this model and `extraModels`. */
  model: Schema.optionalKey(text),
  reasoningEffort: Schema.optionalKey(text),
  /** Context window in tokens. Required for a `responses` provider and a
   *  generic `chat-completions` one. Where the provider reports the model's
   *  own window (Codex, llama.cpp, OpenRouter) it may only lower it. */
  contextLimit: Schema.optionalKey(positive),
  /** More models listed beside `model`, for the main model to give a sub-agent. */
  extraModels: Schema.optionalKey(names),
  /** The model for small side jobs (chat names, approval review) and for
   *  background work. Each must be `model` or one of `extraModels`. Absent: `model`. */
  helperModel: Schema.optionalKey(text),
  backgroundModel: Schema.optionalKey(text),
  /** Most model steps one run may take. */
  maxSteps: Schema.optionalKey(positive),
  /** Most model requests the whole data folder may make, across chats,
   *  sub-agents, side jobs and restarts. The next request fails. */
  maxModelRequests: Schema.optionalKey(positive),
  /** False declares every allowed tool to the model up front, as other
   *  harnesses do, instead of letting it search for tools. */
  toolSearch: Schema.optionalKey(Schema.Boolean),
  /** Allow-list: the model is offered only these tools. At most one of this and `blockedTools`. */
  tools: Schema.optionalKey(names),
  /** Block-list: every tool is offered except these `sources` (whole groups) and `tools` (names). */
  blockedTools: Schema.optionalKey(Schema.Struct({ sources: names, tools: names })),
  /** Sub-agent limits, when `spawn_agent` is offered. Absent: depth 3, 4 at once. */
  subAgents: Schema.optionalKey(
    Schema.Struct({
      maxDepth: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(2), Schema.isLessThanOrEqualTo(3))
      ),
      maxConcurrent: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10))
      )
    })
  ),
  /** Every message runs in this mode: `allow` never asks, `read_only` changes nothing. */
  approvalMode: Schema.optionalKey(Schema.Literals(APPROVAL_MODES)),
  /** When the context is compacted: at `threshold` of the window, keeping
   *  `keepRatio` of it as is, with a summary of at most `summaryMaxTokens`. */
  compaction: Schema.optionalKey(
    Schema.Struct({
      threshold: Schema.optionalKey(
        Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.1), Schema.isLessThanOrEqualTo(1))
      ),
      keepRatio: Schema.optionalKey(
        Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
      ),
      summaryMaxTokens: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(256), Schema.isLessThanOrEqualTo(8_000))
      )
    })
  ),
  /** The one folder file tools may change. */
  workspace: Schema.optionalKey(absolute),
  /** True when a person follows these chats as they run. Absent or false: a
   *  chat works on its request directly instead of handing it to a child to
   *  stay free for the next message. */
  userFacing: Schema.optionalKey(Schema.Boolean),
  /** False keeps Memory recall and related chats out of every prompt. */
  memory: Schema.optionalKey(Schema.Boolean),
  /** False turns every Automation off, built-in ones included. */
  automations: Schema.optionalKey(Schema.Boolean),
  /** Automations `automations: false` leaves on, by id. */
  keepAutomations: Schema.optionalKey(names),
  mcpServers: Schema.optionalKey(Schema.Array(McpServerSchema)),
  /** Read-only Skill folders; `[]` reads none beside Arden's own. */
  skillRoots: Schema.optionalKey(Schema.Array(absolute)),
  /** False runs shell commands without Arden's sandbox, for a throwaway container. */
  commandSandbox: Schema.optionalKey(Schema.Boolean),
  /** Idle-compaction delay; 0 compacts only when the context fills. */
  idleCompactionAfterMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

export type Settings = typeof SettingsSchema.Type

/** A settings file the caller can fix: the message says which field and why. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsError"
  }
}

const BASE_URL_ISSUES: Record<Exclude<BaseUrlIssue, "insecure">, string> = {
  invalid: "is not a URL",
  credentials: "must not contain credentials",
  fragment: "must not contain a fragment: a request path is appended to it",
  query: "must not contain a query: a request path is appended to it"
}

const decode = Schema.decodeUnknownSync(SettingsSchema)

export const parseSettings = (value: unknown): Settings => {
  let settings: Settings
  try {
    settings = decode(value, { onExcessProperty: "error" })
  } catch (cause) {
    throw new SettingsError(`Invalid settings: ${errorMessage(cause).replaceAll(/\n\s*/g, " ")}`)
  }
  if (settings.tools !== undefined && settings.blockedTools !== undefined)
    throw new SettingsError("Invalid settings: give `tools` or `blockedTools`, not both")
  if (settings.extraModels !== undefined && settings.model === undefined)
    throw new SettingsError("Invalid settings: `extraModels` needs `model`")
  if (settings.model !== undefined && settings.extraModels?.includes(settings.model))
    throw new SettingsError("Invalid settings: `extraModels` repeats `model`")
  for (const field of [
    "reasoningEffort",
    "contextLimit",
    "helperModel",
    "backgroundModel"
  ] as const)
    if (settings[field] !== undefined && settings.model === undefined)
      throw new SettingsError(`Invalid settings: \`${field}\` needs \`model\``)
  const listed = [settings.model, ...(settings.extraModels ?? [])]
  for (const field of ["helperModel", "backgroundModel"] as const)
    if (settings[field] !== undefined && !listed.includes(settings[field]))
      throw new SettingsError(
        `Invalid settings: \`${field}\` must be \`model\` or one of \`extraModels\``
      )
  const provider = settings.provider
  if (provider !== undefined && "baseUrl" in provider) checkBaseUrl(provider)
  if (provider?.kind === "responses")
    requireFields(settings, "a `responses` provider", ["model", "contextLimit"])
  // An absent `server` is checked once it is detected, by the same rule.
  if (provider?.kind === "chat-completions" && provider.server !== undefined)
    requireServerFields(settings, provider.server)
  return settings
}

type BaseUrlProvider = Extract<NonNullable<Settings["provider"]>, { readonly baseUrl: string }>

/**
 * A key never crosses the network in clear text: a provider that sends one
 * (`apiKeyEnv`, which a `responses` provider always has) goes over HTTPS or to
 * this machine. One that sends none may use plain HTTP to any host, such as a
 * llama.cpp on the Docker host or the LAN. Discovery and chat requests both
 * use this `baseUrl`, so this one check covers them all.
 */
const checkBaseUrl = (provider: BaseUrlProvider): void => {
  const sendsKey = provider.apiKeyEnv !== undefined
  const issue = baseUrlIssue(provider.baseUrl, { http: sendsKey ? "loopback" : "any" })
  if (issue === undefined) return
  throw new SettingsError(
    `Invalid settings: \`provider.baseUrl\` ${issue === "insecure" ? insecureReason(provider) : BASE_URL_ISSUES[issue]}`
  )
}

const insecureReason = (provider: BaseUrlProvider): string => {
  const url = new URL(provider.baseUrl)
  if (url.protocol !== "http:")
    return provider.apiKeyEnv === undefined
      ? "must use HTTPS or HTTP"
      : "must use HTTPS or loopback HTTP"
  const remedy =
    provider.kind === "responses"
      ? "use HTTPS; a `responses` provider always sends a key"
      : "use HTTPS, or remove `apiKeyEnv` if the server needs no key"
  return `would send the key in clear text to ${url.hostname}: ${remedy}`
}

type ModelField = "model" | "contextLimit"

/**
 * What a `chat-completions` provider needs from the settings: what its server
 * does not report. llama.cpp lists its models and their windows; OpenRouter
 * lists windows for hundreds of models, so the settings pick one.
 */
const SERVER_NEEDS: Record<ChatCompletionsServer, ReadonlyArray<ModelField>> = {
  "llama.cpp": [],
  openrouter: ["model"],
  generic: ["model", "contextLimit"]
}

export const requireServerFields = (settings: Settings, server: ChatCompletionsServer): void =>
  requireFields(
    settings,
    `a \`chat-completions\` provider on ${server === "generic" ? "a generic server" : server}`,
    SERVER_NEEDS[server]
  )

const requireFields = (
  settings: Settings,
  who: string,
  fields: ReadonlyArray<ModelField>
): void => {
  if (fields.some((field) => settings[field] === undefined))
    throw new SettingsError(
      `Invalid settings: ${who} needs ${fields.map((field) => `\`${field}\``).join(" and ")}`
    )
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
