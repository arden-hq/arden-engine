import { clipLine, firstLine } from "@arden-hq/std/text"
import { isRecord } from "@arden-hq/std/json"

import type { JsonValue, ProviderToolCall } from "../../contracts/messages.js"
import type { ToolDeclaration, ToolSearch } from "../../contracts/tools.js"
import { parseJsonText } from "@arden-hq/std/json-text"

export const TOOL_SEARCH_TOOL_NAME = "tool_search"

const SUMMARY_CHARS = 160

const RETRY_HINT = 'Call tool_search again with one JSON object such as {"query": "send email"}.'

export interface AnsweredToolSearch {
  readonly call: ProviderToolCall
  readonly tools: ReadonlyArray<ToolDeclaration>
}

type SearchInput =
  | { readonly ok: true; readonly query: string; readonly limit?: number }
  | { readonly ok: false; readonly error: string }

const searchInput = (raw: unknown): SearchInput => {
  let decoded: unknown = raw
  if (typeof raw === "string") {
    try {
      decoded = parseJsonText(raw)
    } catch {
      return { ok: false, error: `tool_search arguments are not valid JSON. ${RETRY_HINT}` }
    }
  }
  const query = isRecord(decoded) && typeof decoded.query === "string" ? decoded.query.trim() : ""
  if (!isRecord(decoded) || query.length === 0)
    return { ok: false, error: `tool_search needs a non-empty string "query". ${RETRY_HINT}` }
  const limit = decoded.limit
  return typeof limit === "number" && Number.isFinite(limit)
    ? { ok: true, query, limit }
    : { ok: true, query }
}

const recordedArguments = (raw: unknown): Readonly<Record<string, JsonValue>> => {
  let decoded: unknown = raw
  if (typeof raw === "string") {
    try {
      decoded = parseJsonText(raw)
    } catch {
      return {}
    }
  }
  return isRecord(decoded) ? (decoded as Readonly<Record<string, JsonValue>>) : {}
}

const resultText = (tools: ReadonlyArray<ToolDeclaration>): string =>
  tools.length === 0
    ? "No tools matched. Search again with other capability keywords, a group name from the listing, or select:name for an exact tool."
    : [
        `Loaded ${tools.length === 1 ? "1 tool" : `${tools.length} tools`}; call ${tools.length === 1 ? "it" : "them"} directly now:`,
        ...tools.map((tool) => {
          const summary = clipLine(firstLine(tool.description), SUMMARY_CHARS)
          return summary.length === 0 ? `- ${tool.name}` : `- ${tool.name}: ${summary}`
        })
      ].join("\n")

export const pendingToolSearch = (id: string, raw: unknown): ProviderToolCall => ({
  id,
  name: TOOL_SEARCH_TOOL_NAME,
  arguments: recordedArguments(raw),
  result: "",
  done: false,
  loaded_tool_names: [],
  source_refs: []
})

export const answerToolSearch = (
  id: string,
  raw: unknown,
  search: ToolSearch | undefined
): AnsweredToolSearch => {
  const input = searchInput(raw)
  const tools =
    !input.ok || search === undefined
      ? []
      : search.search(
          input.limit === undefined
            ? { query: input.query }
            : { query: input.query, limit: input.limit }
        ).tools
  return {
    call: {
      id,
      name: TOOL_SEARCH_TOOL_NAME,
      arguments: recordedArguments(raw),
      result: input.ok ? resultText(tools) : input.error,
      done: true,
      loaded_tool_names: tools.map((tool) => tool.name),
      source_refs: []
    },
    tools
  }
}

export const isToolSearchCall = (call: ProviderToolCall): boolean =>
  call.name === TOOL_SEARCH_TOOL_NAME
