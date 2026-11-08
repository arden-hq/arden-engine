import type { JsonValue, ProviderToolCall } from "../../contracts/messages.js"
import type { ToolSearch } from "../../contracts/tools.js"
import {
  asRecord,
  stringValue,
  TOOL_SEARCH_TOOL_NAME,
  type OutputItem,
  type ToolSearchCallOutputItem,
  type ToolSearchOutputInputItem
} from "./items.js"
import { namespacedTools } from "./tools.js"

export interface AnsweredToolSearches {
  /** The response's items with each client search followed by its output. */
  readonly items: ReadonlyArray<OutputItem | ToolSearchOutputInputItem>
  readonly calls: ReadonlyArray<ProviderToolCall>
}

export const answerToolSearches = (
  output: ReadonlyArray<OutputItem>,
  toolSearch: ToolSearch | undefined
): AnsweredToolSearches => {
  const calls: Array<ProviderToolCall> = []
  const items = output.flatMap((item): ReadonlyArray<OutputItem | ToolSearchOutputInputItem> => {
    if (item.type !== "tool_search_call" || item.execution !== "client") return [item]
    const query = searchQuery(item)
    const result =
      toolSearch === undefined || query === null
        ? { tools: [], matched: [] }
        : toolSearch.search(query)
    const loaded = result.tools.map((tool) => tool.name)
    calls.push({
      id: item.id,
      name: TOOL_SEARCH_TOOL_NAME,
      arguments: toolSearchArguments(query),
      result: loaded.length === 0 ? "No matching tools." : `Loaded: ${loaded.join(", ")}`,
      done: true,
      loaded_tool_names: loaded,
      source_refs: []
    })
    return [
      item,
      {
        type: "tool_search_output",
        call_id: item.call_id,
        status: "completed",
        execution: "client",
        tools: namespacedTools(result.tools)
      }
    ]
  })
  return { items, calls }
}

/** The live row a search shows while the model's response is still streaming. */
export const pendingToolSearchCall = (item: ToolSearchCallOutputItem): ProviderToolCall => ({
  id: item.id,
  name: TOOL_SEARCH_TOOL_NAME,
  arguments: toolSearchArguments(searchQuery(item)),
  result: "",
  done: false,
  loaded_tool_names: [],
  source_refs: []
})

const searchQuery = (
  item: ToolSearchCallOutputItem
): { readonly query: string; readonly limit?: number } | null => {
  const raw = asRecord(
    typeof item.arguments === "string" ? parseJson(item.arguments) : item.arguments
  )
  const query = stringValue(raw?.query)?.trim()
  if (query === undefined || query.length === 0) return null
  const limit = raw?.limit
  return typeof limit === "number" && Number.isFinite(limit) ? { query, limit } : { query }
}

const toolSearchArguments = (
  query: { readonly query: string; readonly limit?: number } | null
): Readonly<Record<string, JsonValue>> => {
  if (query === null) return {}
  return query.limit === undefined
    ? { query: query.query }
    : { query: query.query, limit: query.limit }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
