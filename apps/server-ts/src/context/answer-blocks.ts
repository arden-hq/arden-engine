import { cutText } from "@arden-hq/std/text"
import { answerBlockText } from "@arden-hq/answer-ui"
import { answerBlockTitle, replaceAnswerBlocks } from "@arden-hq/protocol/chat"

const SUMMARY_CHARS = 300

const compactAnswerBlock = (body: string): string => {
  const lines = answerBlockText(body)
    .split("\n")
    .map((line) => line.trim())
  const heading = lines.find((line) => line.startsWith("## "))?.slice(3)
  const title = heading ?? answerBlockTitle(body)
  const summary = cutText(
    lines
      .filter((line) => line.length > 0 && !line.startsWith("## ") && !TABLE_RULE.test(line))
      .map(plainLine)
      .filter((line) => line.length > 0)
      .join("; "),
    SUMMARY_CHARS
  )
  const label = title === undefined ? "interactive block" : `interactive block: ${title}`
  return summary.length === 0 ? `[${label}]` : `[${label} — ${summary}]`
}

const COMPACT_CACHE_SIZE = 256
const compacted = new Map<string, string>()

const cachedCompactBlock = (body: string): string => {
  const known = compacted.get(body)
  if (known !== undefined) return known
  const line = compactAnswerBlock(body)
  if (compacted.size >= COMPACT_CACHE_SIZE) {
    const oldest = compacted.keys().next()
    if (oldest.done !== true) compacted.delete(oldest.value)
  }
  compacted.set(body, line)
  return line
}

export const compactAnswerBlocks = (markdown: string): string =>
  replaceAnswerBlocks(markdown, cachedCompactBlock)

const TABLE_RULE = /^\|(?:\s*-+\s*\|)+$/

const plainLine = (line: string): string =>
  line.startsWith("|")
    ? line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" ")
    : line.replace(/\*\*(.+?)\*\*/g, "$1")

interface HistoryMessage {
  readonly role: string
  readonly content?: unknown
  readonly is_meta?: unknown
  readonly message_id?: unknown
}

const answerBlockReference = (messageId: string, block: number): string =>
  `(answer_block_read: message_id "${messageId}", block ${block})`

export const projectAnswerBlocks = <Message extends HistoryMessage>(
  messages: ReadonlyArray<Message>
): ReadonlyArray<Message> => {
  const latestUser = messages.findLastIndex(
    (message) => message.role === "user" && message.is_meta !== true
  )
  const latestAnswer = messages.findLastIndex(
    (message, index) => index < latestUser && message.role === "assistant" && hasText(message)
  )
  return messages.map((message, index) =>
    message.role !== "assistant" || index === latestAnswer || index > latestUser
      ? message
      : withCompactBlocks(message)
  )
}

const hasText = (message: HistoryMessage): boolean =>
  Array.isArray(message.content)
    ? message.content.some((block: unknown) => isTextBlock(block) && block.text.trim().length > 0)
    : typeof message.content === "string" && message.content.trim().length > 0

const isTextBlock = (block: unknown): block is { readonly type: "text"; readonly text: string } =>
  typeof block === "object" &&
  block !== null &&
  "type" in block &&
  block.type === "text" &&
  "text" in block &&
  typeof block.text === "string"

const withCompactBlocks = <Message extends HistoryMessage>(message: Message): Message => {
  const messageId = typeof message.message_id === "string" ? message.message_id : undefined
  let ordinal = 0
  const compact = (markdown: string): string =>
    replaceAnswerBlocks(markdown, (body) => {
      ordinal += 1
      const line = cachedCompactBlock(body)
      return messageId === undefined ? line : `${line} ${answerBlockReference(messageId, ordinal)}`
    })
  const content = message.content
  if (typeof content === "string") {
    const text = compact(content)
    return text === content ? message : { ...message, content: text }
  }
  if (!Array.isArray(content)) return message
  const blocks = content.map((block: unknown) => {
    if (!isTextBlock(block)) return block
    const text = compact(block.text)
    return text === block.text ? block : { ...block, text }
  })
  return blocks.some((block, index) => block !== content[index])
    ? { ...message, content: blocks }
    : message
}
