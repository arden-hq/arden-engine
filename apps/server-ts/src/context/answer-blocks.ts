import { CONTENT_BLOCK_TYPE } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { replaceAnswerBlocks } from "@arden-hq/protocol/chat"
import { isWrittenByPerson } from "../persistence/transcript/model.js"
import { compactAnswerBlock } from "../persistence/transcript/content.js"

interface HistoryMessage {
  readonly role: string
  readonly content?: unknown
  readonly message_id?: unknown
}

const answerBlockReference = (messageId: string, block: number): string =>
  `(answer_block_read: message_id "${messageId}", block ${block})`

export const projectAnswerBlocks = <Message extends HistoryMessage>(
  messages: ReadonlyArray<Message>
): ReadonlyArray<Message> => {
  const latestUser = messages.findLastIndex((message) => isWrittenByPerson(message))
  const latestAnswer = messages.findLastIndex(
    (message, index) => index < latestUser && message.role === ROLE.assistant && hasText(message)
  )
  return messages.map((message, index) =>
    message.role !== ROLE.assistant || index === latestAnswer || index > latestUser
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
  block.type === CONTENT_BLOCK_TYPE.text &&
  "text" in block &&
  typeof block.text === "string"

const withCompactBlocks = <Message extends HistoryMessage>(message: Message): Message => {
  const messageId = typeof message.message_id === "string" ? message.message_id : undefined
  let ordinal = 0
  const compact = (markdown: string): string =>
    replaceAnswerBlocks(markdown, (body) => {
      ordinal += 1
      const line = compactAnswerBlock(body)
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
