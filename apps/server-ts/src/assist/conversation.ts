import type { StoredMessageEnvelope } from "../persistence/transcript/model.js"
import { transcriptSearchText } from "../persistence/transcript/search-text.js"
import { cutText } from "@arden-hq/std/text"

export const conversationLine = (
  message: StoredMessageEnvelope,
  maxChars: number
): ReadonlyArray<string> => {
  if (message.role !== "user" && message.role !== "assistant") return []
  if (message.is_meta === true) return []
  const content = transcriptSearchText(message)
  return content === null ? [] : [`${message.role}: ${cutText(content, maxChars)}`]
}

export const newestWithinBudget = (entries: ReadonlyArray<string>, maxChars: number): string => {
  const selected: Array<string> = []
  let length = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined) continue
    const separatorLength = selected.length === 0 ? 0 : 2
    if (length + separatorLength + entry.length > maxChars) break
    selected.unshift(entry)
    length += separatorLength + entry.length
  }
  return selected.join("\n\n")
}
