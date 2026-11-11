import { expect, it } from "vitest"
import type { ChatMessage, ReplyContext } from "../src/index.js"
import { projectReplies } from "../src/agent/replies.js"

const earlier: ReplyContext = { messageId: "a1", role: "assistant", content: "Earlier answer" }
const later: ReplyContext = { messageId: "a2", role: "assistant", content: "Later answer" }
const block = (quoted: ReplyContext) => ({
  type: "context",
  content_type: "reply_to_message",
  content: quoted.content,
  metadata: { message_id: quoted.messageId, role: quoted.role }
})

it("shows the model every message a reply quotes, in order, before the reply's own words", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    { role: "user", content: "One quote", replyTo: earlier },
    { role: "user", content: "Two quotes", replyTo: [earlier, later] },
    { role: "user", content: "No quote" }
  ]

  expect(projectReplies(messages)).toEqual([
    { role: "user", content: [block(earlier), { type: "text", text: "One quote" }] },
    {
      role: "user",
      content: [block(earlier), block(later), { type: "text", text: "Two quotes" }]
    },
    { role: "user", content: "No quote" }
  ])
})
