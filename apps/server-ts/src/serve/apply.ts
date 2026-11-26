import { parseJsonBody } from "@arden-hq/protocol/common"
import {
  MCP_CONNECTION_STATUS,
  MCP_DIAGNOSTICS,
  MCP_FOLDER,
  MCP_SERVER_DETAIL,
  mcpDecoders,
  mcpRequests,
  mcpRoutes,
  type McpServer
} from "@arden-hq/protocol/mcp"
import {
  PERMISSION_PATH_ACCESS,
  PERMISSION_RULE_DECISION,
  PERMISSION_RULE_LIST,
  PERMISSION_RULE_SUBJECT,
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

export type ToolSettings = Pick<Settings, "tools" | "blockedTools">

interface CatalogTool {
  readonly name: string
  readonly source: string | null
}

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
  | { readonly kind: typeof PERMISSION_RULE_SUBJECT.tool; readonly tool: string }
  | {
      readonly kind: typeof PERMISSION_RULE_SUBJECT.path
      readonly path: string
      readonly access: typeof PERMISSION_PATH_ACCESS.change
    }

export type ServerRequest = (path: string, init?: RequestInit) => Promise<Response>

export interface AppliedSettings {
  readonly offeredTools: ReadonlyArray<string> | undefined
  readonly toolsWithoutRule: ReadonlyArray<string>
  readonly mcpServers: ReadonlyArray<string>
}

export interface ApplyInput {
  readonly request: ServerRequest
  readonly settings: Settings
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly keepAutomations?: ReadonlyArray<string>
}

const json = { "content-type": "application/json" }

const MCP_CONNECT_TIMEOUT_MS = 60_000

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
  const held = permissionDecoders
    .rules(await call(permissionRoutes.rules))
    .rules.filter((entry) => entry.list.kind === PERMISSION_RULE_LIST.global)
  const heldRule = (subject: RuleSubject) =>
    held.find((entry) =>
      subject.kind === PERMISSION_RULE_SUBJECT.tool
        ? entry.subject.kind === PERMISSION_RULE_SUBJECT.tool &&
          entry.subject.tool === subject.tool &&
          entry.subject.owner.kind === PERMISSION_TOOL_OWNER.arden
        : entry.subject.kind === PERMISSION_RULE_SUBJECT.path &&
          entry.subject.path === subject.path &&
          entry.subject.access === subject.access
    )
  const rule = async (
    decision: typeof PERMISSION_RULE_DECISION.allow | typeof PERMISSION_RULE_DECISION.never,
    subject: RuleSubject
  ): Promise<boolean> => {
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
      body: JSON.stringify({ list: { kind: PERMISSION_RULE_LIST.global }, decision, subject }),
      ...(signal === undefined ? {} : { signal })
    })
    const detail = await response.text()
    if (response.status === 422) return false
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
      const failed = servers.find((server) => server.status === MCP_CONNECTION_STATUS.failed)
      if (failed !== undefined)
        throw new SettingsError(`MCP server ${failed.name} failed: ${failureText(failed)}`)
      if (
        servers.length === wanted.size &&
        servers.every((server) => server.status === MCP_CONNECTION_STATUS.connected)
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

  const catalog = toolDecoders.catalog(await call(toolRoutes.catalog))
  const offered = offeredTools(settings, catalog.tools)
  const toolsWithoutRule: Array<string> = []
  if (offered !== undefined) {
    for (const tool of catalog.tools) {
      const wanted = offered.has(tool.name)
      if (
        await rule(wanted ? PERMISSION_RULE_DECISION.allow : PERMISSION_RULE_DECISION.never, {
          kind: PERMISSION_RULE_SUBJECT.tool,
          tool: tool.name
        })
      )
        continue
      if (wanted && settings.tools !== undefined)
        throw new SettingsError(`Tool always asks the owner: ${tool.name}`)
      toolsWithoutRule.push(tool.name)
    }
  }
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
    const allowed = await rule(PERMISSION_RULE_DECISION.allow, {
      kind: PERMISSION_RULE_SUBJECT.path,
      path: settings.workspace,
      access: PERMISSION_PATH_ACCESS.change
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
