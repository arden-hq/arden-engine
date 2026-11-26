import { parseJsonTextOrUndefined } from "@arden-hq/protocol/common"
import { APPROVAL_MODES } from "@arden-hq/protocol/permissions"
import { errorMessage } from "@arden-hq/std/errors"
import { baseUrlIssue, type BaseUrlIssue, SERVER_URL_ISSUE, WEB_PROTOCOL } from "@arden-hq/std/url"
import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import {
  CHAT_COMPLETIONS_SERVER,
  CHAT_COMPLETIONS_SERVERS,
  type ChatCompletionsServer
} from "../providers/chat-completions/discovery.js"

const text = Schema.String.check(Schema.isMinLength(1))
const positive = Schema.Int.check(Schema.isGreaterThan(0))
const names = Schema.Array(text).check(Schema.isUnique())
const absolute = text.check(
  Schema.makeFilter((path) => (isAbsolute(path) ? undefined : "must be an absolute path"))
)

export const SERVE_PROVIDER = {
  responses: "responses",
  codex: "codex",
  chatCompletions: "chat-completions",
  codexLogin: "codex-login"
} as const

const ProviderSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(SERVE_PROVIDER.responses),
    baseUrl: text,
    apiKeyEnv: text
  }),
  Schema.Struct({
    kind: Schema.Literal(SERVE_PROVIDER.codex),
    accessTokenEnv: text,
    accountIdEnv: Schema.optionalKey(text)
  }),
  Schema.Struct({
    kind: Schema.Literal(SERVE_PROVIDER.chatCompletions),
    baseUrl: text,
    apiKeyEnv: Schema.optionalKey(text),
    server: Schema.optionalKey(Schema.Literals(CHAT_COMPLETIONS_SERVERS))
  }),
  Schema.Struct({ kind: Schema.Literal(SERVE_PROVIDER.codexLogin) })
])

const McpServerSchema = Schema.Struct({
  name: text,
  command: text,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(text),
  environment: Schema.optionalKey(Schema.Record(text, text))
})

const SettingsSchema = Schema.Struct({
  dataDirectory: absolute,
  port: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65535))
  ),
  provider: Schema.optionalKey(ProviderSchema),
  model: Schema.optionalKey(text),
  reasoningEffort: Schema.optionalKey(text),
  contextLimit: Schema.optionalKey(positive),
  extraModels: Schema.optionalKey(names),
  helperModel: Schema.optionalKey(text),
  backgroundModel: Schema.optionalKey(text),
  maxSteps: Schema.optionalKey(positive),
  maxModelRequests: Schema.optionalKey(positive),
  toolSearch: Schema.optionalKey(Schema.Boolean),
  tools: Schema.optionalKey(names),
  blockedTools: Schema.optionalKey(Schema.Struct({ sources: names, tools: names })),
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
  approvalMode: Schema.optionalKey(Schema.Literals(APPROVAL_MODES)),
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
  workspace: Schema.optionalKey(absolute),
  userFacing: Schema.optionalKey(Schema.Boolean),
  memory: Schema.optionalKey(Schema.Boolean),
  automations: Schema.optionalKey(Schema.Boolean),
  keepAutomations: Schema.optionalKey(names),
  mcpServers: Schema.optionalKey(Schema.Array(McpServerSchema)),
  skillRoots: Schema.optionalKey(Schema.Array(absolute)),
  commandSandbox: Schema.optionalKey(Schema.Boolean),
  idleCompactionAfterMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

export type Settings = typeof SettingsSchema.Type

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
  if (provider?.kind === SERVE_PROVIDER.responses)
    requireFields(settings, "a `responses` provider", ["model", "contextLimit"])
  if (provider?.kind === SERVE_PROVIDER.chatCompletions && provider.server !== undefined)
    requireServerFields(settings, provider.server)
  return settings
}

type BaseUrlProvider = Extract<NonNullable<Settings["provider"]>, { readonly baseUrl: string }>

const checkBaseUrl = (provider: BaseUrlProvider): void => {
  const sendsKey = provider.apiKeyEnv !== undefined
  const issue = baseUrlIssue(provider.baseUrl, { http: sendsKey ? "loopback" : "any" })
  if (issue === undefined) return
  throw new SettingsError(
    `Invalid settings: \`provider.baseUrl\` ${issue === SERVER_URL_ISSUE.insecure ? insecureReason(provider) : BASE_URL_ISSUES[issue]}`
  )
}

const insecureReason = (provider: BaseUrlProvider): string => {
  const url = new URL(provider.baseUrl)
  if (url.protocol !== WEB_PROTOCOL.http)
    return provider.apiKeyEnv === undefined
      ? "must use HTTPS or HTTP"
      : "must use HTTPS or loopback HTTP"
  const remedy =
    provider.kind === SERVE_PROVIDER.responses
      ? "use HTTPS; a `responses` provider always sends a key"
      : "use HTTPS, or remove `apiKeyEnv` if the server needs no key"
  return `would send the key in clear text to ${url.hostname}: ${remedy}`
}

type ModelField = "model" | "contextLimit"

const SERVER_NEEDS: Record<ChatCompletionsServer, ReadonlyArray<ModelField>> = {
  [CHAT_COMPLETIONS_SERVER.llamaCpp]: [],
  [CHAT_COMPLETIONS_SERVER.openrouter]: ["model"],
  [CHAT_COMPLETIONS_SERVER.generic]: ["model", "contextLimit"]
}

export const requireServerFields = (settings: Settings, server: ChatCompletionsServer): void =>
  requireFields(
    settings,
    `a \`chat-completions\` provider on ${server === CHAT_COMPLETIONS_SERVER.generic ? "a generic server" : server}`,
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
  const value = parseJsonTextOrUndefined(content)
  if (value === undefined) throw new SettingsError(`The settings file is not JSON: ${path}`)
  return parseSettings(value)
}
