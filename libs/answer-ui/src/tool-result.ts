import { formatBytes } from "@arden-hq/std/count"
import { utf8Bytes } from "./fence.js"
import { parseJsonText } from "@arden-hq/std/json-text"

export const TOOL_RESULT_QUERY = "tool_result"

export const TOOL_RESULT_MAX_BYTES = 256 * 1024

export const TOOL_RESULT_STATUS = { value: "value", unavailable: "unavailable" } as const

export const TOOL_RESULT_MISS = {
  notJson: "not_json",
  noPath: "no_path",
  tooLarge: "too_large"
} as const
export type ToolResultMiss = (typeof TOOL_RESULT_MISS)[keyof typeof TOOL_RESULT_MISS]

export const TOOL_RESULT_VALUE_MISS = { noCall: "no_call", ...TOOL_RESULT_MISS } as const
export type ToolResultValueMiss =
  (typeof TOOL_RESULT_VALUE_MISS)[keyof typeof TOOL_RESULT_VALUE_MISS]

export type ToolResultRead =
  | { readonly status: typeof TOOL_RESULT_STATUS.value; readonly value: JsonValue }
  | { readonly status: typeof TOOL_RESULT_STATUS.unavailable; readonly reason: ToolResultMiss }

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export function readToolResult(result: string, path: string): ToolResultRead {
  const parsed = parseJson(result)
  if (parsed === undefined)
    return { status: TOOL_RESULT_STATUS.unavailable, reason: TOOL_RESULT_MISS.notJson }
  let value: JsonValue = parsed
  for (const segment of pathSegments(path)) {
    const next = child(value, segment)
    if (next === undefined)
      return { status: TOOL_RESULT_STATUS.unavailable, reason: TOOL_RESULT_MISS.noPath }
    value = next
  }
  return utf8Bytes(JSON.stringify(value)) > TOOL_RESULT_MAX_BYTES
    ? { status: TOOL_RESULT_STATUS.unavailable, reason: TOOL_RESULT_MISS.tooLarge }
    : { status: TOOL_RESULT_STATUS.value, value }
}

const MISS_TEXT: Readonly<Record<ToolResultValueMiss, string>> = {
  no_call: "no tool call with that id in this chat",
  not_json: "that tool call's result is text, not JSON, so it has no fields to read",
  no_path: "that tool call's result has nothing at that path",
  too_large: `the value at that path is over ${formatBytes(TOOL_RESULT_MAX_BYTES)}; read a smaller part of it`
}

export const toolResultMissText = (reason: ToolResultValueMiss): string => MISS_TEXT[reason]

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
    return parseJsonText(text) as JsonValue
  } catch {
    return undefined
  }
}
