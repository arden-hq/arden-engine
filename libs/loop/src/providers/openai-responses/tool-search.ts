import type { ProviderToolCall } from "../../contracts/messages.js"
import type { ToolSearch } from "../../contracts/tools.js"
import { answerToolSearch, pendingToolSearch } from "../kit/index.js"
import {
  RESPONSE_ITEM_TYPE,
  TOOL_SEARCH_EXECUTION,
  type OutputItem,
  type ToolSearchCallOutputItem,
  type ToolSearchOutputInputItem
} from "./items.js"
import { namespacedTools } from "./tools.js"

export interface AnsweredToolSearches {
  readonly items: ReadonlyArray<OutputItem | ToolSearchOutputInputItem>
  readonly calls: ReadonlyArray<ProviderToolCall>
}

export const answerToolSearches = (
  output: ReadonlyArray<OutputItem>,
  toolSearch: ToolSearch | undefined
): AnsweredToolSearches => {
  const calls: Array<ProviderToolCall> = []
  const items = output.flatMap((item): ReadonlyArray<OutputItem | ToolSearchOutputInputItem> => {
    if (
      item.type !== RESPONSE_ITEM_TYPE.toolSearchCall ||
      item.execution !== TOOL_SEARCH_EXECUTION.client
    )
      return [item]
    const answered = answerToolSearch(item.id, item.arguments, toolSearch)
    calls.push(answered.call)
    return [
      item,
      {
        type: "tool_search_output",
        call_id: item.call_id,
        status: "completed",
        execution: "client",
        tools: namespacedTools(answered.tools)
      }
    ]
  })
  return { items, calls }
}

export const pendingToolSearchCall = (item: ToolSearchCallOutputItem): ProviderToolCall =>
  pendingToolSearch(item.id, item.arguments)
