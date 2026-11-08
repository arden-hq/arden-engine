import { ageWords } from "@arden-hq/std/time"
import { Predicate } from "effect"

import type { StoredMessageEnvelope } from "../persistence/transcript/model.js"

export const TIME_SINCE_LAST_MESSAGE_CONTEXT = "time_since_last_message"
const IDLE_GAP_THRESHOLD_MS = 30 * 60 * 1_000

interface ConversationMessage {
  readonly role: string
  readonly content?: unknown
  readonly is_meta?: unknown
}

const isIdleGap = (value: unknown): boolean =>
  Predicate.isObject(value) &&
  value.type === "context" &&
  value.content_type === TIME_SINCE_LAST_MESSAGE_CONTEXT

const withoutIdleGap = <Message extends ConversationMessage>(message: Message): Message => {
  if (!Array.isArray(message.content)) return message
  const content = message.content.filter((block) => !isIdleGap(block))
  return content.length === message.content.length ? message : { ...message, content }
}

const idleGapText = (elapsedMs: number): string | null => {
  if (!Number.isFinite(elapsedMs) || elapsedMs < IDLE_GAP_THRESHOLD_MS) return null
  return ageWords(elapsedMs)
}

export const withIdleGapContext = ({
  message,
  elapsedMs
}: {
  readonly message: StoredMessageEnvelope
  readonly elapsedMs: number | null
}): StoredMessageEnvelope => {
  const cleaned = withoutIdleGap(message)
  if (cleaned.is_meta === true || elapsedMs === null) return cleaned
  const text = idleGapText(elapsedMs)
  if (text === null) return cleaned
  const context = {
    type: "context" as const,
    content_type: TIME_SINCE_LAST_MESSAGE_CONTEXT,
    content: text
  }
  if (typeof cleaned.content === "string") {
    return {
      ...cleaned,
      content: [
        context,
        ...(cleaned.content.length === 0 ? [] : [{ type: "text" as const, text: cleaned.content }])
      ]
    }
  }
  if (Array.isArray(cleaned.content)) {
    return { ...cleaned, content: [context, ...cleaned.content] }
  }
  return cleaned
}

export const projectCurrentIdleGap = <Message extends ConversationMessage>(
  messages: ReadonlyArray<Message>
): ReadonlyArray<Message> => {
  const latestUser = messages.findLastIndex(
    (message) => message.role === "user" && message.is_meta !== true
  )
  return messages.map((message, index) =>
    index === latestUser ? message : withoutIdleGap(message)
  )
}
