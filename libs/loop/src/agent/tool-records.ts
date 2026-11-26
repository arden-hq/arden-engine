import { ROLE } from "@arden-hq/std/message-vocabulary"
import { messageId, type ChatMessage } from "../contracts/messages.js"
import { loadedToolNames, type ToolDeclaration } from "../contracts/tools.js"
import type { ModelRequest } from "../contracts/provider.js"

type DeveloperRecord = ChatMessage & { readonly role: typeof ROLE.developer }

const appendOnlyToolRecord = (
  kind: "tool-change" | "tool-load",
  content: string,
  tools:
    | { readonly removed_tools: ReadonlyArray<string> }
    | { readonly loaded_tools: ReadonlyArray<string> }
    | undefined = undefined
): DeveloperRecord => ({
  message_id: messageId(kind),
  role: ROLE.developer,
  content,
  ...tools
})

export const toolsChangedRecord = (
  previous: ReadonlySet<string> | undefined,
  deferred: ReadonlyArray<ToolDeclaration>
): DeveloperRecord | undefined => {
  if (previous === undefined) return undefined
  const current = new Set(deferred.map((tool) => tool.name))
  const added = [...current].filter((name) => !previous.has(name)).sort()
  const removed = [...previous].filter((name) => !current.has(name)).sort()
  if (added.length === 0 && removed.length === 0) return undefined
  return appendOnlyToolRecord(
    "tool-change",
    [
      "Tools changed in this conversation.",
      ...(added.length === 0 ? [] : [`Now found by tool search: ${added.join(", ")}.`]),
      ...(removed.length === 0 ? [] : [`No longer available: ${removed.join(", ")}.`])
    ].join(" "),
    removed.length === 0 ? undefined : { removed_tools: removed }
  )
}

export const preloadRecord = (
  names: ReadonlyArray<string>,
  deferred: ReadonlyArray<ToolDeclaration>,
  loaded: ReadonlySet<string>
): DeveloperRecord | undefined => {
  const catalog = new Set(deferred.map((tool) => tool.name))
  const missing = [...new Set(names)]
    .filter((name) => catalog.has(name) && !loaded.has(name))
    .sort()
  if (missing.length === 0) return undefined
  return appendOnlyToolRecord(
    "tool-load",
    `Tools loaded for this conversation: ${missing.join(", ")}.`,
    { loaded_tools: missing }
  )
}

export const carryLoadedTools = (
  replacement: ReadonlyArray<ChatMessage>,
  loaded: ReadonlySet<string>,
  prepared: ModelRequest
): { readonly history: ReadonlyArray<ChatMessage>; readonly record?: ChatMessage } => {
  const deferred = new Set(prepared.deferredTools.map((tool) => tool.name))
  const kept = loadedToolNames(replacement)
  const names = [...loaded].filter((name) => deferred.has(name) && !kept.has(name)).sort()
  if (names.length === 0) return { history: replacement }
  const record = appendOnlyToolRecord(
    "tool-load",
    `Tools still loaded from earlier in this conversation: ${names.join(", ")}.`,
    { loaded_tools: names }
  )
  return { history: [...replacement, record], record }
}
