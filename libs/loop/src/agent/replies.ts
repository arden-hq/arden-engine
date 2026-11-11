import type { ChatMessage, ReplyContext, UserMessage } from "../contracts/messages.js"

/** Every message a human reply quotes, in the order they were quoted. */
export const replyContexts = (replyTo: UserMessage["replyTo"]): ReadonlyArray<ReplyContext> => {
  if (replyTo === undefined) return []
  return "messageId" in replyTo ? [replyTo] : replyTo
}

export const projectReplies = (messages: ReadonlyArray<ChatMessage>): ReadonlyArray<ChatMessage> =>
  messages.map((message) => {
    if (message.role !== "user" || message.replyTo === undefined) return message
    const { replyTo, ...stored } = message
    const content = contentParts(message.content)
    return {
      ...stored,
      content: [
        ...replyContexts(replyTo).map((quoted) => ({
          type: "context" as const,
          content_type: "reply_to_message",
          content: quoted.content,
          metadata: { message_id: quoted.messageId, role: quoted.role }
        })),
        ...content
      ]
    }
  })

const contentParts = (content: ChatMessage["content"]) => {
  if (typeof content === "string")
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  return Array.isArray(content) ? content : []
}
