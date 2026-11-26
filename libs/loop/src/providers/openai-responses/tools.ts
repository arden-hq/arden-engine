import type { ToolDeclaration, ToolSearch } from "../../contracts/tools.js"
import { OpenAiResponsesProviderError } from "./errors.js"
import { asRecord, TOOL_SEARCH_EXECUTION } from "./items.js"
import { projectFunctionParameters } from "./parameter-schema.js"

export const RESPONSES_TOOL_TYPE = {
  function: "function",
  namespace: "namespace",
  toolSearch: "tool_search",
  webSearch: "web_search"
} as const

export interface FunctionTool {
  readonly async?: boolean
  readonly type: typeof RESPONSES_TOOL_TYPE.function
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly strict: false
  readonly defer_loading?: true
}

export interface ClientToolSearchTool {
  readonly type: typeof RESPONSES_TOOL_TYPE.toolSearch
  readonly execution: typeof TOOL_SEARCH_EXECUTION.client
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface NamespaceTool {
  readonly type: typeof RESPONSES_TOOL_TYPE.namespace
  readonly name: string
  readonly description: string
  readonly tools: ReadonlyArray<FunctionTool>
}

const DEFAULT_NAMESPACE = "tools"

const RESERVED_NAMESPACES: ReadonlySet<string> = new Set(["browser"])

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
