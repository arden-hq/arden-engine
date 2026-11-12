import { APPROVAL_MODES } from "@arden-hq/protocol/permissions"
import { errorMessage } from "@arden-hq/std/errors"
import { serverUrlIssue, type ServerUrlIssue } from "@arden-hq/std/url"
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
const SettingsSchema = Schema.Struct({
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

const BASE_URL_ISSUES: Record<ServerUrlIssue, string> = {
  invalid: "is not a URL",
  credentials: "must not contain credentials",
  fragment: "must not contain a fragment",
  insecure: "must use HTTPS or loopback HTTP"
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
  if (settings.provider?.kind === "responses") {
    // A key goes only to an HTTPS endpoint or to this machine.
    const issue = serverUrlIssue(settings.provider.baseUrl)
    if (issue !== undefined)
      throw new SettingsError(`Invalid settings: \`provider.baseUrl\` ${BASE_URL_ISSUES[issue]}`)
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
