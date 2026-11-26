import { parseJsonBody } from "@arden-hq/protocol/common"
import {
  MCP_DIAGNOSTICS,
  MCP_FOLDER,
  MCP_SERVER_DETAIL,
  mcpDecoders,
  mcpRequests,
  mcpRoutes,
  type McpServer
} from "@arden-hq/protocol/mcp"
import {
  PERMISSION_TOOL_OWNER,
  permissionDecoders,
  permissionRoutes
} from "@arden-hq/protocol/permissions"
import {
  DEFAULT_INTELLIGENCE_SETTINGS,
  INTELLIGENCE_SETTINGS_CHANGE,
  intelligenceSettingsRequests,
  type IntelligenceSettingsPatch
} from "@arden-hq/protocol/settings"
import { toolDecoders, toolRoutes } from "@arden-hq/protocol/tools"
import { sleep } from "@arden-hq/std/sleep"
import { SettingsError, type Settings } from "./settings.js"

/** The tool settings alone, so a caller with its own file format can reuse the rule. */
export type ToolSettings = Pick<Settings, "tools" | "blockedTools">

interface CatalogTool {
  readonly name: string
  readonly source: string | null
}

/**
 * The tools the model is offered: the allow-list as given, or the whole catalog
 * minus the block-list. Undefined when the settings name neither, which leaves
 * the server's own rules alone. A name the catalog does not have is an error.
 */
export const offeredTools = (
  settings: ToolSettings,
  catalog: ReadonlyArray<CatalogTool>
): ReadonlySet<string> | undefined => {
  const known = (kind: string, wanted: ReadonlyArray<string>, present: ReadonlySet<string>) => {
    for (const name of wanted)
      if (!present.has(name)) throw new SettingsError(`Unknown ${kind}: ${name}`)
  }
  const tools = new Set(catalog.map((tool) => tool.name))
  if (settings.tools !== undefined) {
    known("tool", settings.tools, tools)
    return new Set(settings.tools)
  }
  const blocked = settings.blockedTools
  if (blocked === undefined) return undefined
  known("tool", blocked.tools, tools)
  known(
    "tool source",
    blocked.sources,
    new Set(catalog.flatMap((tool) => (tool.source === null ? [] : [tool.source])))
  )
  return new Set(
    catalog
      .filter(
        (tool) =>
          !(tool.source !== null && blocked.sources.includes(tool.source)) &&
          !blocked.tools.includes(tool.name)
      )
      .map((tool) => tool.name)
  )
}

type RuleSubject =
  | { readonly kind: "tool"; readonly tool: string }
  | { readonly kind: "path"; readonly path: string; readonly access: "change" }

/** One request to the started server, already carrying its access header. */
export type ServerRequest = (path: string, init?: RequestInit) => Promise<Response>

export interface AppliedSettings {
  /** Undefined when the settings name no tools: the server's own rules stand. */
  readonly offeredTools: ReadonlyArray<string> | undefined
  /** Tools that take no rule because they always ask the owner. */
  readonly toolsWithoutRule: ReadonlyArray<string>
  readonly mcpServers: ReadonlyArray<string>
}

export interface ApplyInput {
  readonly request: ServerRequest
  readonly settings: Settings
  /** Where an MCP server's `environment` values are read from. */
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  /** Automations `automations: false` leaves on, for a caller that still needs one. */
  readonly keepAutomations?: ReadonlyArray<string>
}

const json = { "content-type": "application/json" }

/** A stdio MCP server that has not connected by now will not: it waits for a sign-in or is off. */
const MCP_CONNECT_TIMEOUT_MS = 60_000

/**
 * Applies what a start option cannot carry, over the server's own HTTP API:
 * Automations off, MCP servers, tool rules, the work folder and sub-agents.
 * Model, step limit, Memory, Skills and the sandbox are start options instead
 * (`serverOptionsFor`).
 */
const failureText = (server: McpServer): string => {
  if (server.diagnostics.kind === MCP_DIAGNOSTICS.captured) return server.diagnostics.text
  return server.detail.kind === MCP_SERVER_DETAIL.shown ? server.detail.text : "null"
}

export const applySettings = async ({
  request,
  settings,
  env,
  signal,
  keepAutomations = []
}: ApplyInput): Promise<AppliedSettings> => {
  const call = async (path: string, method = "GET", body?: string): Promise<unknown> => {
    const response = await request(path, {
      method,
      headers: json,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal })
    })
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return parseJsonBody(response)
  }
  // The rules already on the global list, so a second start on the same data
  // folder changes what differs and adds nothing twice.
  const held = permissionDecoders
    .rules(await call(permissionRoutes.rules))
    .rules.filter((entry) => entry.list.kind === "global")
  const heldRule = (subject: RuleSubject) =>
    held.find((entry) =>
      subject.kind === "tool"
        ? entry.subject.kind === "tool" &&
          entry.subject.tool === subject.tool &&
          entry.subject.owner.kind === PERMISSION_TOOL_OWNER.arden
        : entry.subject.kind === "path" &&
          entry.subject.path === subject.path &&
          entry.subject.access === subject.access
    )
  // Answers false for a subject the server keeps no rule for (422): a tool that
  // always asks the owner.
  const rule = async (decision: "allow" | "never", subject: RuleSubject): Promise<boolean> => {
    const existing = heldRule(subject)
    if (existing !== undefined) {
      if (existing.decision !== decision)
        await call(
          `${permissionRoutes.rules}/${encodeURIComponent(existing.id)}`,
          "PATCH",
          JSON.stringify({ decision })
        )
      return true
    }
    const response = await request(permissionRoutes.rules, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ list: { kind: "global" }, decision, subject }),
      ...(signal === undefined ? {} : { signal })
    })
    const detail = await response.text()
    if (response.status === 422) return false
    // 409: the server already holds this subject under its own spelling (a
    // folder is stored by its real path), so there is nothing to add.
    if (response.status === 409) return true
    if (!response.ok) throw new Error(`Permission rule: ${response.status} ${detail}`)
    return true
  }

  if (settings.automations === false) {
    const { automations } = (await call("/automations")) as {
      readonly automations: ReadonlyArray<{ readonly task_id: string; readonly enabled: boolean }>
    }
    for (const automation of automations) {
      if (automation.enabled && !keepAutomations.includes(automation.task_id))
        await call(`/automations/${encodeURIComponent(automation.task_id)}/toggle`, "POST")
    }
  }

  // A server of the same name from an earlier start is replaced, so the file
  // always wins and a second start does not fail on it.
  const mcpServers = settings.mcpServers ?? []
  const present =
    mcpServers.length === 0
      ? new Set<string>()
      : new Set(mcpDecoders.list(await call(mcpRoutes.collection)).servers.map((s) => s.name))
  for (const server of mcpServers) {
    if (present.has(server.name)) await call(mcpRoutes.server(server.name), "DELETE")
    const set: Record<string, string> = {}
    for (const [name, source] of Object.entries(server.environment ?? {})) {
      const value = env[source]
      if (value === undefined)
        throw new SettingsError(`Missing ${source} for MCP server ${server.name}`)
      set[name] = value
    }
    await call(
      mcpRoutes.collection,
      "POST",
      mcpRequests.create({
        name: server.name,
        transport: {
          type: "stdio",
          command: server.command,
          args: server.args,
          environment: { set, retain: [] },
          cwd:
            server.cwd === undefined
              ? { kind: MCP_FOLDER.keep }
              : { kind: MCP_FOLDER.folder, path: server.cwd }
        }
      })
    )
  }
  if (mcpServers.length > 0) {
    const wanted = new Set(mcpServers.map((server) => server.name))
    const deadline = performance.now() + MCP_CONNECT_TIMEOUT_MS
    while (true) {
      signal?.throwIfAborted()
      const servers = mcpDecoders
        .list(await call(mcpRoutes.collection))
        .servers.filter((server) => wanted.has(server.name))
      const failed = servers.find((server) => server.status === "failed")
      if (failed !== undefined)
        throw new SettingsError(`MCP server ${failed.name} failed: ${failureText(failed)}`)
      if (
        servers.length === wanted.size &&
        servers.every((server) => server.status === "connected")
      )
        break
      if (performance.now() > deadline)
        throw new SettingsError(
          `MCP servers did not connect in ${MCP_CONNECT_TIMEOUT_MS / 1000} s: ${[...wanted]
            .map((name) => `${name} (${servers.find((s) => s.name === name)?.status ?? "missing"})`)
            .join(", ")}`
        )
      await sleep(200, signal)
    }
  }

  // A `never` rule keeps a tool out of what the model is offered; an offered
  // tool gets `allow`. A tool that always asks the owner takes no rule: a
  // server with nobody to answer may not name one in an allow-list.
  const catalog = toolDecoders.catalog(await call(toolRoutes.catalog))
  const offered = offeredTools(settings, catalog.tools)
  const toolsWithoutRule: Array<string> = []
  if (offered !== undefined) {
    for (const tool of catalog.tools) {
      const wanted = offered.has(tool.name)
      if (await rule(wanted ? "allow" : "never", { kind: "tool", tool: tool.name })) continue
      if (wanted && settings.tools !== undefined)
        throw new SettingsError(`Tool always asks the owner: ${tool.name}`)
      toolsWithoutRule.push(tool.name)
    }
  }
  // Sub-agents follow the tool: offered, they get the file's limits or the
  // defaults; not offered, they are off, so the two never disagree. Both are
  // written on every start, so an earlier start's limits do not linger.
  const subAgentLimits = (): IntelligenceSettingsPatch => {
    if (offered !== undefined && !offered.has("spawn_agent"))
      return [
        { kind: INTELLIGENCE_SETTINGS_CHANGE.maxAgentDepth, value: 1 },
        { kind: INTELLIGENCE_SETTINGS_CHANGE.maxConcurrentAgents, value: 1 }
      ]
    if (offered === undefined && settings.subAgents === undefined) return []
    return [
      {
        kind: INTELLIGENCE_SETTINGS_CHANGE.maxAgentDepth,
        value: settings.subAgents?.maxDepth ?? DEFAULT_INTELLIGENCE_SETTINGS.maxAgentDepth
      },
      {
        kind: INTELLIGENCE_SETTINGS_CHANGE.maxConcurrentAgents,
        value:
          settings.subAgents?.maxConcurrent ?? DEFAULT_INTELLIGENCE_SETTINGS.maxConcurrentAgents
      }
    ]
  }
  const compaction = settings.compaction
  const limits: IntelligenceSettingsPatch = [
    ...subAgentLimits(),
    ...(compaction?.threshold === undefined
      ? []
      : [{ kind: INTELLIGENCE_SETTINGS_CHANGE.compactionThreshold, value: compaction.threshold }]),
    ...(compaction?.keepRatio === undefined
      ? []
      : [{ kind: INTELLIGENCE_SETTINGS_CHANGE.compactionKeepRatio, value: compaction.keepRatio }]),
    ...(compaction?.summaryMaxTokens === undefined
      ? []
      : [
          {
            kind: INTELLIGENCE_SETTINGS_CHANGE.summaryMaxTokens,
            value: compaction.summaryMaxTokens
          }
        ])
  ]
  if (limits.length > 0)
    await call("/settings/intelligence", "PATCH", intelligenceSettingsRequests.update(limits))

  if (settings.workspace !== undefined) {
    const allowed = await rule("allow", {
      kind: "path",
      path: settings.workspace,
      access: "change"
    })
    if (!allowed)
      throw new SettingsError(`The server refused the work folder: ${settings.workspace}`)
  }

  return {
    offeredTools: offered === undefined ? undefined : [...offered],
    toolsWithoutRule,
    mcpServers: mcpServers.map((server) => server.name)
  }
}
