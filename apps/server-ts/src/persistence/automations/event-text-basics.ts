import { clipLine } from "@arden-hq/std/text"
import type { JsonValue } from "@arden-hq/protocol"
import { Predicate } from "effect"

const FIELD_CHARS = 200

const PAYLOAD_FIELDS = 12
export const LISTED_VALUES = 10

export interface EventLines {
  readonly what: string
  readonly at: number
  readonly source: string
  readonly excerpt: ReadonlyArray<string>
  readonly followUps: ReadonlyArray<ToolCall>
  readonly note: string | undefined
}

export interface ToolCall {
  readonly tool: string
  readonly text: string
}

export const call = (tool: string, args: string): ToolCall => ({ tool, text: `${tool}(${args})` })

export const CHANGE_AUTHORS: Readonly<Record<string, string>> = {
  user: "the user",
  agent: "an agent",
  automation: "an Automation",
  system: "Arden"
}

export const jsonText = (value: string): string => JSON.stringify(clipLine(value, FIELD_CHARS))

export const payloadLines = (data: JsonValue | undefined): ReadonlyArray<string> => {
  if (data === undefined) return []
  if (!Predicate.isObject(data) || Array.isArray(data)) return [JSON.stringify(data)]
  const entries = Object.entries(data)
  return [
    ...entries
      .slice(0, PAYLOAD_FIELDS)
      .map(
        ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`
      ),
    ...(entries.length > PAYLOAD_FIELDS
      ? [`and ${entries.length - PAYLOAD_FIELDS} more fields`]
      : [])
  ]
}

export const listed = (values: ReadonlyArray<string>): string => {
  const shown = values.slice(0, LISTED_VALUES).map(jsonText)
  const more = values.length - shown.length
  return [...shown, ...(more === 0 ? [] : [`and ${more} more`])].join(", ")
}
