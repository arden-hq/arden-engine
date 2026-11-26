import { LINK } from "@arden-hq/protocol"
import { describe, expect, it } from "vitest"
import { lifecycleSse } from "../src/http/automations/lifecycle-sse.js"

const frameData = (event: Parameters<typeof lifecycleSse>[0]) => {
  const frame = lifecycleSse(event)
  return frame._tag === "Event" ? JSON.parse(frame.data) : undefined
}

describe("automation event stream frames", () => {
  it("keeps the chat a question change names", () => {
    expect(
      frameData({
        kind: "record",
        sequence: 7,
        createdAtMs: 1_000,
        replayed: false,
        event: {
          type: "question_changed",
          question_id: "question-1",
          run_id: "run-1",
          session_id: "chat-1",
          task: { kind: LINK.none }
        }
      })
    ).toEqual(expect.objectContaining({ session_id: "chat-1", seq: 7 }))
  })

  it("keeps the chat a blocking-work change names", () => {
    expect(
      frameData({
        kind: "record",
        sequence: 8,
        createdAtMs: 1_000,
        replayed: true,
        event: { type: "session_blocking_work", session_id: "chat-2", blocking_work: true }
      })
    ).toEqual(expect.objectContaining({ session_id: "chat-2", seq: 8, replay: true }))
  })
})
