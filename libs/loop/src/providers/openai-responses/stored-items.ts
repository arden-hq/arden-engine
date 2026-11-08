import type { AssistantMessage, ChatMessage } from "../../contracts/messages.js"
import { SemanticResponseError } from "../kit/index.js"
import { OpenAiResponsesProviderError } from "./errors.js"
import {
  asRecord,
  messageItemText,
  normalizeOutputItem,
  PROVIDER_STATE_KEY,
  stringValue,
  SYNTHETIC_OUTPUT_ID_PREFIX,
  type InputItem,
  type StoredResponseItem,
  type ToolSearchCallInputItem,
  type ToolSearchOutputInputItem
} from "./items.js"
import { projectFunctionParameters } from "./parameter-schema.js"
import { providerNamespace } from "./tools.js"

const decodeStoredItem = (value: unknown): StoredResponseItem => {
  const raw = asRecord(value)
  const type = raw === null ? null : stringValue(raw.type)
  if (type === "tool_search_call") {
    if (
      (typeof raw?.call_id !== "string" && raw?.call_id !== null) ||
      typeof raw.execution !== "string" ||
      !("arguments" in raw) ||
      (raw.id !== undefined && typeof raw.id !== "string") ||
      (raw.status !== undefined && typeof raw.status !== "string")
    ) {
      throw new SemanticResponseError("Stored tool search call is invalid")
    }
    return raw as ToolSearchCallInputItem
  }
  if (type === "tool_search_output") {
    if (
      (typeof raw?.call_id !== "string" && raw?.call_id !== null) ||
      typeof raw.status !== "string" ||
      typeof raw.execution !== "string" ||
      !Array.isArray(raw.tools) ||
      (raw.id !== undefined && typeof raw.id !== "string")
    ) {
      throw new SemanticResponseError("Stored tool search output is invalid")
    }
    return raw as ToolSearchOutputInputItem
  }
  if (
    (type === "message" || type === "reasoning" || type === "web_search_call") &&
    typeof raw?.id !== "string"
  ) {
    throw new SemanticResponseError("Stored output item is missing an id")
  }
  return normalizeOutputItem(value, "")
}

const storedResponseItems = (
  message: AssistantMessage
): { readonly items: unknown } | undefined => {
  const state = message.provider_state
  if (state !== undefined && PROVIDER_STATE_KEY in state)
    return { items: state[PROVIDER_STATE_KEY] }
  return "openai_response_items" in message ? { items: message.openai_response_items } : undefined
}

/**
 * A found tool replayed on this request's route: under the namespace this wire
 * accepts, and `async` only when this request declares the tool async. A
 * search answered on a GPT-6 route stored its tools with `async: true`; replayed
 * verbatim to gpt-5.6 the whole request was refused (HTTP 400, 2026-09-29).
 */
const replayedFoundTool = (tool: unknown, asyncTools: ReadonlySet<string>): unknown => {
  const raw = asRecord(tool)
  if (raw === null) return tool
  if (raw.type === "namespace" && typeof raw.name === "string" && Array.isArray(raw.tools)) {
    return {
      ...raw,
      name: providerNamespace(raw.name),
      tools: raw.tools.map((inner) => replayedFoundTool(inner, asyncTools))
    }
  }
  const parameters = asRecord(raw.parameters)
  const projected =
    raw.type === "function" && parameters !== null
      ? { ...raw, parameters: projectFunctionParameters(parameters) }
      : raw
  if (raw.async !== true || (typeof raw.name === "string" && asyncTools.has(raw.name)))
    return projected
  const { async: _, ...portable } = projected
  return portable
}

/**
 * `asyncTools` names the tools this request declares `async` — the route's
 * own capability, already applied by the loop. Stored items follow it, never
 * the route that first produced them.
 */
export const responseItems = (
  message: ChatMessage,
  asyncTools: ReadonlySet<string>
): ReadonlyArray<InputItem> | undefined => {
  if (message.role !== "assistant") return undefined
  const stored = storedResponseItems(message)
  if (stored === undefined) return undefined
  const nativeAsync = new Set(
    (message.tool_calls ?? []).flatMap((call) => (call.async === true ? [call.id] : []))
  )
  try {
    if (!Array.isArray(stored.items))
      throw new SemanticResponseError("Stored output items must be an array")
    const items = stored.items.map(decodeStoredItem)
    return items.flatMap((item): ReadonlyArray<InputItem> => {
      if (item.type === "tool_search_call") return [{ ...item }]
      if (item.type === "tool_search_output") {
        return [{ ...item, tools: item.tools.map((tool) => replayedFoundTool(tool, asyncTools)) }]
      }
      if (item.type === "function_call") {
        const native = nativeAsync.has(item.call_id)
        return [
          Object.fromEntries(
            Object.entries(item).flatMap(([key, value]): ReadonlyArray<[string, unknown]> => {
              if (key === "async") return native ? [[key, value]] : []
              if (key === "namespace" && typeof value === "string")
                return [[key, providerNamespace(value)]]
              return [[key, value]]
            })
          )
        ]
      }
      if (item.type === "reasoning" && item.id.startsWith(SYNTHETIC_OUTPUT_ID_PREFIX)) {
        return []
      }
      if (item.type === "reasoning") {
        return [
          {
            type: "reasoning",
            id: item.id,
            ...(item.encrypted_content === undefined
              ? {}
              : { encrypted_content: item.encrypted_content }),
            summary: item.summary,
            ...(item.content === undefined ? {} : { content: item.content })
          }
        ]
      }
      if (item.type !== "message" || !item.id.startsWith(SYNTHETIC_OUTPUT_ID_PREFIX)) {
        return [item as unknown as InputItem]
      }
      return [
        {
          role: "assistant",
          content: messageItemText(item),
          ...(item.phase === undefined ? {} : { phase: item.phase })
        }
      ]
    })
  } catch {
    throw new OpenAiResponsesProviderError("Stored OpenAI response history is invalid")
  }
}
