import { formatBytes } from "@arden-hq/std/count"
import { utf8Bytes } from "./fence.js"

/** The one Query tool a block may name. It only reads; nothing runs. */
export const TOOL_RESULT_QUERY = "tool_result"

/** The largest value, in UTF-8 bytes of its JSON, one Query returns. */
export const TOOL_RESULT_MAX_BYTES = 256 * 1024

/** Why a value cannot be read from a tool result. */
export type ToolResultMiss =
  /** The result is not JSON: a text result has no fields to bind. */
  | "not_json"
  /** The path names a field or index the result does not have. */
  | "no_path"
  /** The value at the path is over `TOOL_RESULT_MAX_BYTES`. */
  | "too_large"

export type ToolResultRead =
  | { readonly status: "value"; readonly value: JsonValue }
  | { readonly status: "unavailable"; readonly reason: ToolResultMiss }

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

/** The value at `path` in a tool result's text. The path is dot-separated
 *  (`items.0.price`, `items[0].price` reads the same); a number indexes a
 *  list; an empty path is the whole result. */
export function readToolResult(result: string, path: string): ToolResultRead {
  const parsed = parseJson(result)
  if (parsed === undefined) return { status: "unavailable", reason: "not_json" }
  let value: JsonValue = parsed
  for (const segment of pathSegments(path)) {
    const next = child(value, segment)
    if (next === undefined) return { status: "unavailable", reason: "no_path" }
    value = next
  }
  return utf8Bytes(JSON.stringify(value)) > TOOL_RESULT_MAX_BYTES
    ? { status: "unavailable", reason: "too_large" }
    : { status: "value", value }
}

/** How a miss reads to the model that wrote the Query. */
export function toolResultMissText(reason: ToolResultMiss | "no_call"): string {
  switch (reason) {
    case "no_call":
      return "no tool call with that id in this chat"
    case "not_json":
      return "that tool call's result is text, not JSON, so it has no fields to read"
    case "no_path":
      return "that tool call's result has nothing at that path"
    case "too_large":
      return `the value at that path is over ${formatBytes(TOOL_RESULT_MAX_BYTES)}; read a smaller part of it`
  }
}

function pathSegments(path: string): ReadonlyArray<string> {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

function child(value: JsonValue, segment: string): JsonValue | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (isList(value)) return /^\d+$/.test(segment) ? value[Number(segment)] : undefined
  return Object.hasOwn(value, segment) ? value[segment] : undefined
}

const isList = (value: object): value is ReadonlyArray<JsonValue> => Array.isArray(value)

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}
