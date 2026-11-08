import { contentParts } from "./content.js"
import {
  answerBlockLabel,
  replaceAnswerBlocks,
  stripCitationMarkers
} from "@arden-hq/protocol/chat"
import { isChatEventsMessage } from "./chat-events.js"
import type { StoredMessageEnvelope } from "./model.js"

export const transcriptSearchText = (message: StoredMessageEnvelope): string | null => {
  if (
    message.role === "developer" ||
    message.superseded === true ||
    typeof message.forked_from === "string" ||
    isChatEventsMessage(message)
  )
    return null
  const text = replaceAnswerBlocks(
    stripCitationMarkers(
      contentParts(message.content)
        .flatMap((part) => {
          switch (part.type) {
            case "text":
              return [part.text]
            case "context":
              return part.content ? [part.content] : []
            case "image":
            case "audio":
              return []
          }
        })
        .join("\n\n")
    ),
    answerBlockLabel
  ).trim()
  return text.length === 0 ? null : text
}
