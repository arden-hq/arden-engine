import { HistoryMessageSchema } from "@arden-hq/protocol/effect/chat"
import { DateTime, Schema } from "effect"
import { expect, it } from "vitest"
import type { StampedTranscriptMessageRecord } from "../src/chat/history-projection.js"
import { projectMessage } from "../src/chat/history-rows.js"
import { StoredMessageEnvelopeSchema } from "../src/persistence/transcript/model.js"

const AT = "2026-11-24T09:00:00.000Z"

const record = (fields: Record<string, unknown>): StampedTranscriptMessageRecord => {
  const envelope = Schema.decodeUnknownSync(StoredMessageEnvelopeSchema)({
    created_at: AT,
    ...fields
  })
  return {
    sessionId: "chat-1",
    messageId: envelope.message_id,
    sequence: 3,
    role: envelope.role,
    clientId: null,
    createdAt: DateTime.makeUnsafe(AT),
    envelope: { ...envelope, turn_id: "turn-1" }
  }
}

const project = (envelope: Record<string, unknown>) =>
  projectMessage(record(envelope), new Map(), "conversation", new Map(), undefined, undefined)
    ?.message

it("projects a forwarded steer with its quote as a decodable row", () => {
  const message = project({
    message_id: "m-1",
    role: "user",
    content: "hello",
    applied_at: AT,
    replyTo: { messageId: "m-0", role: "assistant", content: "earlier" },
    forwarded_from: { session_id: "chat-2", session_ref: "ref-2", message_id: "m-9" }
  })
  expect(Schema.decodeUnknownSync(HistoryMessageSchema)(message)).toEqual(
    expect.objectContaining({
      client: { kind: "untracked" },
      applied: { kind: "stamped", at: AT },
      reply_to: [{ message_id: "m-0", role: "assistant", content: "earlier" }],
      question_answer: { kind: "none" },
      sent_from: { kind: "typed" },
      forwarded_from: {
        kind: "forwarded",
        session_id: "chat-2",
        session_ref: "ref-2",
        message_id: "m-9"
      },
      images: [],
      compact: false
    })
  )
})

it("projects an agent's report with its sender and preview as tagged states", () => {
  const message = project({
    message_id: "m-2",
    role: "interaction",
    kind: "completion",
    outcome: "completed",
    from: { source: "agent", id: "ref-3" },
    content: "Report",
    agent_result: { session_id: "chat-3", name: "Researcher", content: "Found it" }
  })
  expect(Schema.decodeUnknownSync(HistoryMessageSchema)(message)).toEqual(
    expect.objectContaining({
      from: { source: "agent", id: "ref-3", name: { kind: "unnamed" } },
      to: { kind: "unaddressed" },
      caused_by: { kind: "untraced" },
      from_chat: { kind: "direct" },
      update: { kind: "none" },
      agent_result: {
        kind: "report",
        result: {
          session_id: "chat-3",
          name: "Researcher",
          content: "Found it",
          preview: { kind: "previewed", text: "Found it" }
        }
      }
    })
  )
})

it("projects a tool row's outcome and data", () => {
  const message = project({
    message_id: "m-3",
    role: "tool",
    tool_call_id: "call-1",
    content: "ok",
    is_error: true,
    data: { rows: 2 }
  })
  expect(Schema.decodeUnknownSync(HistoryMessageSchema)(message)).toEqual(
    expect.objectContaining({
      tool_call_id: "call-1",
      status: {
        kind: "settled",
        is_error: true,
        retry: "unstated",
        duration: { kind: "untimed" }
      },
      data: { kind: "attached", value: { rows: 2 } }
    })
  )
})
