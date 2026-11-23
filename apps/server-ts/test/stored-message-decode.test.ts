import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { toChatRunnerMessages } from "../src/chat/run-driver.js"
import type { StoredMessageEnvelope } from "../src/persistence/transcript/model.js"

const createdAt = "2026-09-26T10:00:00.000Z"

const stored: ReadonlyArray<StoredMessageEnvelope> = [
  { message_id: "system", role: ROLE.system, created_at: createdAt, content: "You are Arden." },
  {
    message_id: "developer",
    role: ROLE.developer,
    created_at: createdAt,
    content: [{ type: "text", text: "Runtime context" }],
    turn_id: "user"
  },
  {
    message_id: "user",
    role: ROLE.user,
    created_at: createdAt,
    client_id: "client-1",
    turn_id: "user",
    content: [
      {
        type: "context",
        content_type: "time_since_last_message",
        content: "2.0 days",
        metadata: { source: "session" }
      },
      { type: "text", text: "Continue." }
    ],
    replyTo: { messageId: "earlier", role: ROLE.assistant, content: "Earlier answer" }
  },
  {
    message_id: "steer",
    role: ROLE.user,
    created_at: createdAt,
    applied_at: createdAt,
    content: "Also check the logs.",
    interaction: {
      from: { type: "user", id: "owner" },
      to: { type: "agent", id: "arden" },
      kind: "message",
      content: "Also check the logs."
    }
  },
  {
    message_id: "assistant",
    role: ROLE.assistant,
    created_at: createdAt,
    content: "Checking.",
    reasoning_content: "Look first.",
    tool_calls: [
      { id: "call-1", type: "function", function: { name: "inspect", arguments: "{}" } }
    ],
    output_parts: [
      { type: "reasoning", text: "Look first." },
      { type: "text", text: "Checking.", phase: "commentary" },
      { type: "tool_call", tool_call_id: "call-1", execution: "runtime" }
    ],
    extension: { kept: true }
  },
  {
    message_id: "tool",
    role: ROLE.tool,
    created_at: createdAt,
    tool_call_id: "call-1",
    content: "done"
  }
]

describe("stored message decoding", () => {
  it("decodes every valid stored message to the value the old cast produced", () => {
    const decoded = Effect.runSync(toChatRunnerMessages("session-1", stored))

    expect(decoded).toStrictEqual(stored.map((message) => ({ ...message })))
  })

  it("decodes a reply that quotes several messages, and refuses one that quotes none", () => {
    const quoting = (replyTo: StoredMessageEnvelope["replyTo"]): StoredMessageEnvelope => ({
      message_id: "quoting",
      role: ROLE.user,
      created_at: createdAt,
      content: "Compare these.",
      replyTo
    })
    const several = quoting([
      { messageId: "earlier", role: ROLE.assistant, content: "Earlier answer" },
      { messageId: "later", role: ROLE.assistant, content: "Later answer" }
    ])

    expect(Effect.runSync(toChatRunnerMessages("session-1", [several]))).toStrictEqual([
      { ...several }
    ])
    const none = Effect.runSync(Effect.flip(toChatRunnerMessages("session-1", [quoting([])])))
    expect(none).toMatchObject({ sessionId: "session-1", messageId: "quoting", position: 1 })

    const badSecond = quoting([
      { messageId: "earlier", role: ROLE.assistant, content: "Earlier answer" },
      { messageId: "", role: ROLE.assistant, content: "Later answer" }
    ])
    const refused = Effect.runSync(Effect.flip(toChatRunnerMessages("session-1", [badSecond])))
    expect(refused).toMatchObject({ sessionId: "session-1", messageId: "quoting", position: 1 })
  })

  it("fails on the first message that does not decode, naming the session and message", () => {
    const error = Effect.runSync(
      Effect.flip(
        toChatRunnerMessages("session-1", [
          ...stored.slice(0, 2),
          { message_id: "broken-tool", role: ROLE.tool, created_at: createdAt, content: "orphan" }
        ])
      )
    )

    expect(error).toMatchObject({
      _tag: "StoredMessageDecodeError",
      sessionId: "session-1",
      messageId: "broken-tool",
      position: 3
    })
  })
})
