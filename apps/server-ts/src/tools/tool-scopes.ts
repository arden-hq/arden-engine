import { isUserAutomation, type Actor } from "../execution/authority.js"
import type { ToolScopeKey } from "../execution/policy.js"
import type { ServerTool, ServerToolMetadata } from "./define.js"

const CODE_AGENT_SOURCES = new Set(["_code", "_filesystem", "_skills", "_system", "_web"])

const WORKER_EXCLUDED_SOURCES = new Set([
  "_automations",
  "_spaces",
  "_directives",
  "_goals",
  "_sessions",
  "_todos",
  "_app",
  "_skills"
])

const OUTCOME_SCOPES: ReadonlySet<ToolScopeKey> = new Set([
  "worker",
  "observer",
  "read_only",
  "reports",
  "browser",
  "memory_capture",
  "chat_summary",
  "agent_research",
  "agent_code"
])

const isRead = (metadata: ServerToolMetadata) => metadata.action === "read"

const SCOPE_RULES: Record<
  ToolScopeKey,
  {
    readonly internal: boolean
    readonly matches: (metadata: ServerToolMetadata) => boolean
  }
> = {
  none: { internal: false, matches: () => false },
  worker: {
    internal: true,
    matches: (metadata) => isRead(metadata) || !WORKER_EXCLUDED_SOURCES.has(metadata.source)
  },
  observer: { internal: false, matches: isRead },
  read_only: { internal: false, matches: isRead },
  reports: { internal: false, matches: isRead },
  browser: {
    internal: false,
    matches: (metadata) => isRead(metadata) || metadata.source === "_browser"
  },
  memory_capture: {
    internal: false,
    matches: (metadata) => isRead(metadata) && metadata.source === "_wiki"
  },
  chat_summary: { internal: false, matches: () => false },
  agent_research: { internal: false, matches: isRead },
  agent_code: {
    internal: false,
    matches: (metadata) =>
      (isRead(metadata) && CODE_AGENT_SOURCES.has(metadata.source)) ||
      metadata.source === "_filesystem" ||
      metadata.source === "_shell" ||
      metadata.source === "_code"
  },
  space: { internal: false, matches: () => true },
  all: { internal: false, matches: () => true }
}

const joinsScope = (metadata: ServerToolMetadata, scope: ToolScopeKey): boolean =>
  metadata.scopes.includes(scope) ||
  (metadata.outcome && OUTCOME_SCOPES.has(scope)) ||
  (metadata.internal_catalog && metadata.private_scope === scope)

export const scopedToolNames = (
  tools: ReadonlyArray<ServerTool>
): Record<ToolScopeKey, ReadonlySet<string>> => {
  const scopeNames = (scope: ToolScopeKey): ReadonlySet<string> => {
    const rule = SCOPE_RULES[scope]
    return new Set(
      tools
        .filter((tool) => {
          const metadata = tool.meta
          return (
            ((rule.internal || !metadata.internal_catalog || metadata.invocation_only === true) &&
              rule.matches(metadata)) ||
            joinsScope(metadata, scope)
          )
        })
        .map((tool) => tool.definition.name)
    )
  }
  return {
    none: scopeNames("none"),
    worker: scopeNames("worker"),
    observer: scopeNames("observer"),
    read_only: scopeNames("read_only"),
    reports: scopeNames("reports"),
    browser: scopeNames("browser"),
    all: scopeNames("all"),
    space: scopeNames("space"),
    memory_capture: scopeNames("memory_capture"),
    chat_summary: scopeNames("chat_summary"),
    agent_research: scopeNames("agent_research"),
    agent_code: scopeNames("agent_code")
  }
}

export type ToolHolder = { readonly kind: "run"; readonly actor: Actor } | { readonly kind: "tree" }

export const scopedRunToolNames = (
  tools: ReadonlyArray<ServerTool>,
  scopes: ReturnType<typeof scopedToolNames>,
  primary: ToolScopeKey,
  intersections: ReadonlyArray<ToolScopeKey>,
  holder: ToolHolder,
  shellByRules = false
): ReadonlySet<string> =>
  new Set(
    tools
      .filter((tool) => {
        return toolAvailableInScopes({
          tool,
          scopeNames: scopes,
          scopes: [primary, ...intersections],
          primaryScopes: [primary],
          holder,
          shellByRules
        })
      })
      .map((tool) => tool.definition.name)
  )

export const toolAvailableInScopes = (input: {
  readonly tool: ServerTool
  readonly scopeNames: Record<ToolScopeKey, ReadonlySet<string>>
  readonly scopes: ReadonlyArray<ToolScopeKey>
  readonly primaryScopes: ReadonlyArray<ToolScopeKey | undefined>
  readonly holder: ToolHolder
  readonly shellByRules?: boolean
}): boolean => {
  const metadata = input.tool.meta
  if (
    metadata.actor === "user_automation" &&
    input.holder.kind === "run" &&
    !isUserAutomation(input.holder.actor)
  )
    return false
  const named = (scope: ToolScopeKey) => input.scopeNames[scope].has(input.tool.definition.name)
  const byRules =
    input.shellByRules === true &&
    metadata.source === "_shell" &&
    input.scopes.filter((scope) => !input.primaryScopes.includes(scope)).every(named)
  if (!byRules && !input.scopes.every(named)) return false
  if (!metadata.internal_catalog) return true
  if (metadata.invocation_only === true) return true
  return (
    input.primaryScopes.length > 0 &&
    input.primaryScopes.every((scope) => scope !== undefined && metadata.private_scope === scope)
  )
}

export const toolRunsUnattended = (
  tool: ServerTool,
  scopes: ReadonlyArray<ToolScopeKey>
): boolean => {
  const scope = tool.meta.unattended_scope
  return scope !== undefined && (scopes.includes(scope) || scopes.includes("all"))
}
