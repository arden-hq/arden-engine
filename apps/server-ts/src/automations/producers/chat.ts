import { clipLine } from "@arden-hq/std/text"
import type { AutomationTriggerEvent, QuietChat } from "../../persistence/automations/model.js"
import type { AutomationEventProducer } from "../event-producer.js"

const QUIET_GAP_MINUTES = 10
const EXCERPTS = 5
const EXCERPT_CHARS = 300

interface QuietStretch {
  readonly firstSeq: number
  readonly lastSeq: number
  readonly lastAt: string
  readonly yourMessages: ReadonlyArray<string>
}

const quietStretch = (messages: QuietChat["messages"]): QuietStretch | undefined => {
  const [last] = messages
  if (last === undefined) return undefined
  const yours: string[] = []
  let first = last
  for (const message of messages) {
    if (Date.parse(first.createdAt) - Date.parse(message.createdAt) >= QUIET_GAP_MINUTES * 60_000)
      break
    if (message.role === "user") yours.unshift(message.text)
    first = message
  }
  return { firstSeq: first.seq, lastSeq: last.seq, lastAt: last.createdAt, yourMessages: yours }
}

export const chatQuietEvent = (chat: QuietChat): AutomationTriggerEvent | undefined => {
  const stretch = quietStretch(chat.messages)
  if (stretch === undefined) return undefined
  return {
    eventType: "chat.quiet",
    eventKey: `${chat.sessionId}:${stretch.lastSeq}`,
    producedBy: null,
    chainDepth: 0,
    context: {
      chat: {
        session_id: chat.sessionId,
        session_ref: chat.publicRef,
        name: chat.name ?? "",
        space: chat.spaceName ?? "",
        your_messages: stretch.yourMessages.length,
        from_sequence: stretch.firstSeq,
        through_sequence: stretch.lastSeq,
        last_message_at: stretch.lastAt,
        excerpts: stretch.yourMessages.slice(-EXCERPTS).map((text) => clipLine(text, EXCERPT_CHARS))
      }
    }
  }
}

export const chatQuietEventProducer: AutomationEventProducer<"chat.quiet"> = {
  eventType: "chat.quiet",
  source: { kind: "feed" },
  failureMessage: "Chat quiet Automation trigger failed"
}
