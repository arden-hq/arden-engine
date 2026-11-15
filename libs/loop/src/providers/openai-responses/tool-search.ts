import type { ProviderToolCall } from "../../contracts/messages.js"
import type { ToolSearch } from "../../contracts/tools.js"
import { answerToolSearch, pendingToolSearch } from "../kit/index.js"
import type { OutputItem, ToolSearchCallOutputItem, ToolSearchOutputInputItem } from "./items.js"
import { namespacedTools } from "./tools.js"

export interface AnsweredToolSearches {
  /** The response's items with each client search followed by its output. */
  readonly items: ReadonlyArray<OutputItem | ToolSearchOutputInputItem>
  readonly calls: ReadonlyArray<ProviderToolCall>
}

/**
 * Answers each client search with the kit's `answerToolSearch`. The wire's
 * `tool_search_output` carries only the found tools, so a malformed search
 * reaches the model as an empty output; its correction stays in the call's
 * `result`, which a later Chat Completions request replays.
 */
export const answerToolSearches = (
  output: ReadonlyArray<OutputItem>,
  toolSearch: ToolSearch | undefined
): AnsweredToolSearches => {
  const calls: Array<ProviderToolCall> = []
  const items = output.flatMap((item): ReadonlyArray<OutputItem | ToolSearchOutputInputItem> => {
    if (item.type !== "tool_search_call" || item.execution !== "client") return [item]
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

/** The live row a search shows while the model's response is still streaming. */
export const pendingToolSearchCall = (item: ToolSearchCallOutputItem): ProviderToolCall =>
  pendingToolSearch(item.id, item.arguments)
