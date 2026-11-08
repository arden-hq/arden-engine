import { cutText } from "@arden-hq/std/text"
import { Schema } from "effect"

import { workflowHash } from "../identity.js"
import type { NestedCallFacts } from "./contract.js"

export const PREVIEW_CHARS = 200
const ARG_CHARS = 200

export interface ScriptProgressTool extends NestedCallFacts {
  readonly phase_id: string | null
  readonly tool_call_id: string
  readonly name: string
  readonly phase: string | null
  readonly status: "running" | "completed" | "failed"
  readonly changes_state: boolean
  readonly args: Readonly<Record<string, Schema.Json>>
  readonly preview: string | null
}

export const nestedCallIds = (parentToolCallId: string, marker: string) => {
  const occurrences = new Map<string, number>()
  return (name: string, args: Schema.Json): string => {
    const contentKey = workflowHash({ name, args }).slice(0, 24)
    const occurrence = occurrences.get(contentKey) ?? 0
    occurrences.set(contentKey, occurrence + 1)
    return `${parentToolCallId}${marker}${contentKey}:${occurrence}`
  }
}

export const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

export const resultPreview = (value: Schema.Json): string | null =>
  isJsonObject(value) && typeof value["preview"] === "string"
    ? value["preview"].slice(0, PREVIEW_CHARS)
    : null

export const trimmedArgs = (
  args: Readonly<Record<string, Schema.Json>>
): Readonly<Record<string, Schema.Json>> =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? cutText(value, ARG_CHARS) : value
    ])
  )
