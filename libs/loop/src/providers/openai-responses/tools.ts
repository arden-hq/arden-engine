import type { ToolDeclaration, ToolSearch } from "../../contracts/tools.js"
import { OpenAiResponsesProviderError } from "./errors.js"
import { asRecord } from "./items.js"
import { projectFunctionParameters } from "./parameter-schema.js"

export interface FunctionTool {
  readonly async?: boolean
  readonly type: "function"
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly strict: false
  readonly defer_loading?: true
}

export interface ClientToolSearchTool {
  readonly type: "tool_search"
  readonly execution: "client"
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface NamespaceTool {
  readonly type: "namespace"
  readonly name: string
  readonly description: string
  readonly tools: ReadonlyArray<FunctionTool>
}

const DEFAULT_NAMESPACE = "tools"

/**
 * Namespaces OpenAI keeps for its own tools. A request that declares or
 * replays a function inside one is refused with HTTP 400 ("Function
 * 'browser.browser_screenshot' is not allowed in reserved namespace
 * 'browser'", seen 2026-09-27).
 */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set(["browser"])

/** The namespace a group travels under on this wire: its own name, unless OpenAI reserves it. */
export const providerNamespace = (group: string): string =>
  RESERVED_NAMESPACES.has(group) ? `${group}_tools` : group

export const functionTool = (tool: ToolDeclaration): FunctionTool => {
  if (tool.name.trim().length === 0 || asRecord(tool.parameters) === null) {
    throw new OpenAiResponsesProviderError(
      "The tool catalog contains an unsupported function schema"
    )
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: projectFunctionParameters(tool.parameters),
    strict: false,
    ...(tool.async === true ? { async: true } : {})
  }
}

export const clientToolSearchTool = (search: ToolSearch): ClientToolSearchTool => ({
  type: "tool_search",
  execution: "client",
  description: search.description,
  parameters: search.parameters
})

/**
 * Found tools grouped into namespaces, in order of first appearance. OpenAI's
 * models were trained to search namespaces, and a namespaced call comes back
 * with its `namespace` beside the tool's own name.
 */
export const namespacedTools = (
  declarations: ReadonlyArray<ToolDeclaration>
): ReadonlyArray<NamespaceTool> => {
  const groups = new Map<string, Array<FunctionTool>>()
  for (const declaration of declarations) {
    const name = providerNamespace(declaration.group ?? DEFAULT_NAMESPACE)
    const tools = groups.get(name) ?? []
    tools.push({ ...functionTool(declaration), defer_loading: true })
    groups.set(name, tools)
  }
  return [...groups.entries()].map(([name, tools]) => ({
    type: "namespace",
    name,
    description: `Tools in the ${name} namespace.`,
    tools
  }))
}
