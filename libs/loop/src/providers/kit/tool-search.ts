/**
 * Client-side tool search as every adapter answers it: the search tool's
 * name, how a model's search arguments are read, and what the model and the
 * history are told about the result. A wire with a native search item (the
 * Responses `tool_search_call`) and a wire where the search is an ordinary
 * function tool (Chat Completions) answer the same call the same way, so a
 * conversation can move between them.
 */
import { clipLine, firstLine } from "@arden-hq/std/text"
import { isRecord } from "@arden-hq/std/json"

import type { JsonValue, ProviderToolCall } from "../../contracts/messages.js"
import type { ToolDeclaration, ToolSearch } from "../../contracts/tools.js"
import { parseJsonText } from "@arden-hq/std/json-text"

/** The search tool's name on every wire, in history, and in the host's tool words. */
export const TOOL_SEARCH_TOOL_NAME = "tool_search"

/** How much of a found tool's description its result line keeps. */
const SUMMARY_CHARS = 160

const RETRY_HINT = 'Call tool_search again with one JSON object such as {"query": "send email"}.'

export interface AnsweredToolSearch {
  /** The finished call as history records it: arguments, result text, loaded names. */
  readonly call: ProviderToolCall
  /** The declarations the search loaded, in result order. */
  readonly tools: ReadonlyArray<ToolDeclaration>
}

type SearchInput =
  | { readonly ok: true; readonly query: string; readonly limit?: number }
  | { readonly ok: false; readonly error: string }

/**
 * Reads a search call's arguments: JSON text (Chat Completions, most
 * Responses items) or an already-decoded object. A small model writes
 * arguments that are not JSON or lack `query`; that is answered with a
 * correction the model can act on, as the loop answers an ordinary tool's
 * malformed arguments, never a failed run.
 */
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

/** The arguments history keeps: the model's object as written, or `{}` when it wrote none. */
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

/**
 * The result a model reads after a search. Found tools are listed by name
 * and the first line of their description only: from the next request on,
 * each one's full description and parameters are declared as a tool, so the
 * result just says which names became callable and what each is for.
 * Repeating whole descriptions would pay for them twice in a small context.
 * The same text is the call's `result` in history, which a Chat Completions
 * request replays as the search's `tool` message, whichever wire ran it.
 */
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

/** The live row a search shows while the model's response is still streaming. */
export const pendingToolSearch = (id: string, raw: unknown): ProviderToolCall => ({
  id,
  name: TOOL_SEARCH_TOOL_NAME,
  arguments: recordedArguments(raw),
  result: "",
  done: false,
  loaded_tool_names: [],
  source_refs: []
})

/**
 * Runs one search call against the request's catalog. Without a catalog
 * (`search` undefined) nothing can load, and the model is told so.
 */
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

/** A recorded provider call that was a client tool search, whichever wire answered it. */
export const isToolSearchCall = (call: ProviderToolCall): boolean =>
  call.name === TOOL_SEARCH_TOOL_NAME
