import type { ChatMessage } from "../contracts/messages.js"

export const projectReplies = (messages: ReadonlyArray<ChatMessage>): ReadonlyArray<ChatMessage> =>
  messages.map((message) => {
    if (message.role !== "user" || message.replyTo === undefined) return message
    const { replyTo, ...stored } = message
    const content = contentParts(message.content)
    return {
      ...stored,
      content: [
        {
          type: "context",
          content_type: "reply_to_message",
          content: replyTo.content,
          metadata: { message_id: replyTo.messageId, role: replyTo.role }
        },
        ...content
      ]
    }
  })

const contentParts = (content: ChatMessage["content"]) => {
  if (typeof content === "string")
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  return Array.isArray(content) ? content : []
}
