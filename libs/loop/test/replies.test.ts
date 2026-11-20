import { ROLE } from "@arden-hq/std/message-vocabulary"
import { expect, it } from "vitest"
import type { ChatMessage, ReplyContext } from "../src/index.js"
import { projectReplies } from "../src/agent/replies.js"

const earlier: ReplyContext = { messageId: "a1", role: ROLE.assistant, content: "Earlier answer" }
const later: ReplyContext = { messageId: "a2", role: ROLE.assistant, content: "Later answer" }
const block = (quoted: ReplyContext) => ({
  type: "context",
  content_type: "reply_to_message",
  content: quoted.content,
  metadata: { message_id: quoted.messageId, role: quoted.role }
})

it("shows the model every message a reply quotes, in order, before the reply's own words", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    { role: ROLE.user, content: "One quote", replyTo: earlier },
    { role: ROLE.user, content: "Two quotes", replyTo: [earlier, later] },
    { role: ROLE.user, content: "No quote" }
  ]

  expect(projectReplies(messages)).toEqual([
    { role: ROLE.user, content: [block(earlier), { type: "text", text: "One quote" }] },
    {
      role: ROLE.user,
      content: [block(earlier), block(later), { type: "text", text: "Two quotes" }]
    },
    { role: ROLE.user, content: "No quote" }
  ])
})
