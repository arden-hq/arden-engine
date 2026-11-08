import type { JsonObject, Metadata, ToolDisplayTitle } from "@arden-hq/loop"
import { MAX_TOOL_DISPLAY_TITLE_LENGTH, TOOL_DISPLAY_TITLE_ARGUMENT } from "@arden-hq/protocol/chat"

export const TOOL_DISPLAY_TITLE: ToolDisplayTitle = {
  argument: TOOL_DISPLAY_TITLE_ARGUMENT,
  maxLength: MAX_TOOL_DISPLAY_TITLE_LENGTH
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const nullableString = (value: unknown): string | null | undefined =>
  value === null ? null : nonEmptyString(value)

export const persistToolCallHost = (host: Metadata): JsonObject => {
  const displayName = nonEmptyString(host["display_name"])
  const kind = nonEmptyString(host["kind"])
  const icon = nullableString(host["icon"])
  const noun = nullableString(host["noun"])
  const source = nullableString(host["source"])
  return {
    ...(displayName === undefined ? {} : { display_name: displayName }),
    ...(kind === undefined ? {} : { kind }),
    ...(icon === undefined ? {} : { icon }),
    ...(noun === undefined ? {} : { noun }),
    ...(source === undefined ? {} : { source }),
    ...(host["presentation"] === "conversation" ? { presentation: "conversation" } : {})
  }
}
