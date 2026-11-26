import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { AssistantMessage, ChatMessage } from "../../contracts/messages.js"
import { SemanticResponseError } from "../kit/index.js"
import { OpenAiResponsesProviderError } from "./errors.js"
import {
  asRecord,
  messageItemText,
  normalizeOutputItem,
  PROVIDER_STATE_KEY,
  RESPONSE_ITEM_TYPE,
  stringValue,
  type InputItem,
  type StoredResponseItem,
  type ToolSearchCallInputItem,
  type ToolSearchOutputInputItem
} from "./items.js"
import { projectFunctionParameters } from "./parameter-schema.js"
import { OUTPUT_ID_ORIGIN, outputIdOrigin } from "./output-id.js"
import { providerNamespace, RESPONSES_TOOL_TYPE } from "./tools.js"

const decodeStoredItem = (value: unknown): StoredResponseItem => {
  const raw = asRecord(value)
  const type = raw === null ? null : stringValue(raw.type)
  if (type === RESPONSE_ITEM_TYPE.toolSearchCall) {
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
  if (type === RESPONSE_ITEM_TYPE.toolSearchOutput) {
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
    (type === RESPONSE_ITEM_TYPE.message ||
      type === RESPONSE_ITEM_TYPE.reasoning ||
      type === RESPONSE_ITEM_TYPE.webSearchCall) &&
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

const replayedFoundTool = (tool: unknown, asyncTools: ReadonlySet<string>): unknown => {
  const raw = asRecord(tool)
  if (raw === null) return tool
  if (
    raw.type === RESPONSES_TOOL_TYPE.namespace &&
    typeof raw.name === "string" &&
    Array.isArray(raw.tools)
  ) {
    return {
      ...raw,
      name: providerNamespace(raw.name),
      tools: raw.tools.map((inner) => replayedFoundTool(inner, asyncTools))
    }
  }
  const parameters = asRecord(raw.parameters)
  const projected =
    raw.type === RESPONSES_TOOL_TYPE.function && parameters !== null
      ? { ...raw, parameters: projectFunctionParameters(parameters) }
      : raw
  if (raw.async !== true || (typeof raw.name === "string" && asyncTools.has(raw.name)))
    return projected
  const { async: _, ...portable } = projected
  return portable
}

export const responseItems = (
  message: ChatMessage,
  asyncTools: ReadonlySet<string>
): ReadonlyArray<InputItem> | undefined => {
  if (message.role !== ROLE.assistant) return undefined
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
      if (item.type === RESPONSE_ITEM_TYPE.toolSearchCall) return [{ ...item }]
      if (item.type === RESPONSE_ITEM_TYPE.toolSearchOutput) {
        return [{ ...item, tools: item.tools.map((tool) => replayedFoundTool(tool, asyncTools)) }]
      }
      if (item.type === RESPONSE_ITEM_TYPE.functionCall) {
        const { async: _, ...portable } = item
        const kept: InputItem = nativeAsync.has(item.call_id) ? { ...item } : portable
        return [
          item.namespace === undefined
            ? kept
            : { ...kept, namespace: providerNamespace(item.namespace) }
        ]
      }
      if (
        item.type === RESPONSE_ITEM_TYPE.reasoning &&
        outputIdOrigin(item.id) === OUTPUT_ID_ORIGIN.arden
      ) {
        return []
      }
      if (item.type === RESPONSE_ITEM_TYPE.reasoning) {
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
      if (
        item.type !== RESPONSE_ITEM_TYPE.message ||
        outputIdOrigin(item.id) !== OUTPUT_ID_ORIGIN.arden
      ) {
        return [item as unknown as InputItem]
      }
      return [
        {
          role: ROLE.assistant,
          content: messageItemText(item),
          ...(item.phase === undefined ? {} : { phase: item.phase })
        }
      ]
    })
  } catch {
    throw new OpenAiResponsesProviderError("Stored OpenAI response history is invalid")
  }
}
