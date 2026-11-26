import { CONTENT_BLOCK_TYPE } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
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
    message.role === ROLE.developer ||
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
            case CONTENT_BLOCK_TYPE.text:
              return [part.text]
            case CONTENT_BLOCK_TYPE.context:
              return part.content ? [part.content] : []
            case CONTENT_BLOCK_TYPE.image:
            case CONTENT_BLOCK_TYPE.audio:
              return []
          }
        })
        .join("\n\n")
    ),
    answerBlockLabel
  ).trim()
  return text.length === 0 ? null : text
}
