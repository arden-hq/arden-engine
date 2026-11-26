import {
  toolKindOf,
  GMAIL_SEND,
  TOOL_DATA,
  TOOL_EXECUTION,
  TOOL_ICON,
  TOOL_NOUN,
  TOOL_PARENT,
  TOOL_PRESENTATION,
  TOOL_SOURCE,
  TOOL_TITLE,
  toolRetry
} from "@arden-hq/protocol/chat"
import { isJsonObject, type JsonObject } from "../json.js"
import { upgradeQuestionData } from "../runs/stored-question-data.js"

type ToolEventUpgrade = (event: JsonObject) => JsonObject

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const withoutKeys = (event: JsonObject, keys: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(Object.entries(event).filter(([key]) => !keys.includes(key)))

const withExecution: ToolEventUpgrade = (event) => ({
  ...event,
  execution:
    event["execution"] === TOOL_EXECUTION.provider
      ? TOOL_EXECUTION.provider
      : TOOL_EXECUTION.runtime
})

const withKnownKind: ToolEventUpgrade = (event) => ({ ...event, kind: toolKindOf(event["kind"]) })

const toolData = (value: unknown) =>
  isJsonObject(value) ? { kind: TOOL_DATA.attached, value } : { kind: TOOL_DATA.none }

const labelled = <Plain extends string, Named extends string, Key extends string>(
  value: unknown,
  plain: Plain,
  named: Named,
  key: Key
) => {
  const name = text(value)
  return name === undefined ? { kind: plain } : { kind: named, [key]: name }
}

const toolStart: ToolEventUpgrade = (event) => {
  if (isJsonObject(event["parent"])) return withKnownKind(event)
  const parent = text(event["parent_id"])
  const presentation = event["presentation"]
  return {
    ...withExecution(
      withoutKeys(event, ["parent_id", "display_title", "timestamp", "icon", "noun", "source"])
    ),
    parent:
      parent === undefined
        ? { kind: TOOL_PARENT.root }
        : { kind: TOOL_PARENT.child, parent_id: parent },
    display_name: text(event["display_name"]) ?? text(event["tool_call_name"]) ?? "",
    title: labelled(event["display_title"], TOOL_TITLE.untitled, TOOL_TITLE.titled, "text"),
    kind: toolKindOf(event["kind"]),
    icon: labelled(event["icon"], TOOL_ICON.plain, TOOL_ICON.icon, "name"),
    noun: labelled(event["noun"], TOOL_NOUN.unnamed, TOOL_NOUN.noun, "text"),
    source: labelled(event["source"], TOOL_SOURCE.unsourced, TOOL_SOURCE.source, "name"),
    presentation:
      presentation === TOOL_PRESENTATION.conversation || presentation === TOOL_PRESENTATION.status
        ? presentation
        : TOOL_PRESENTATION.work
  }
}

const toolProgress: ToolEventUpgrade = (event) =>
  "execution" in event ? event : { ...withExecution(event), data: toolData(event["data"]) }

const withQuestion: ToolEventUpgrade = (event) => {
  const data = event["data"]
  if (!isJsonObject(data) || data["kind"] !== TOOL_DATA.attached) return event
  const value = data["value"]
  if (!isJsonObject(value)) return event
  return { ...event, data: { kind: TOOL_DATA.attached, value: upgradeQuestionData(value) } }
}

const legacyToolResult: ToolEventUpgrade = (event) => {
  const retryable = event["retryable"]
  const receipt = event["gmail_send_receipt"]
  return {
    ...withExecution(
      withoutKeys(event, [
        "retryable",
        "gmail_send_receipt",
        "outcome",
        "role",
        "raw_ref",
        "content_sha256",
        "content_bytes",
        "retention_class"
      ])
    ),
    content: typeof event["content"] === "string" ? event["content"] : "",
    preview: typeof event["preview"] === "string" ? event["preview"] : "",
    display_name: text(event["display_name"]) ?? text(event["name"]) ?? "",
    kind: toolKindOf(event["kind"]),
    is_error: event["is_error"] === true,
    retry: toolRetry(typeof retryable === "boolean" ? retryable : null),
    duration_ms: typeof event["duration_ms"] === "number" ? event["duration_ms"] : 0,
    data: toolData(event["data"]),
    source_refs: Array.isArray(event["source_refs"]) ? event["source_refs"] : [],
    gmail_send: isJsonObject(receipt)
      ? { kind: GMAIL_SEND.confirmed, receipt }
      : { kind: GMAIL_SEND.unconfirmed }
  }
}

const toolResult: ToolEventUpgrade = (event) =>
  withQuestion(isJsonObject(event["gmail_send"]) ? withKnownKind(event) : legacyToolResult(event))

export const storedToolEventUpgrades = {
  TOOL_CALL_START: toolStart,
  TOOL_CALL_ARGS: withExecution,
  TOOL_CALL_OUTPUT_DELTA: withExecution,
  TOOL_CALL_PROGRESS: toolProgress,
  TOOL_CALL_WAITING: withExecution,
  TOOL_CALL_END: withExecution,
  TOOL_CALL_RESULT: toolResult
} as const
