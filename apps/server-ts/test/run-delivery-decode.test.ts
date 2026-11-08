import { HistoryMessageSchema } from "@arden-hq/protocol/effect/chat"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { RunDeliveryPayloadSchema } from "../src/persistence/deliveries/model.js"

const AT = "2026-10-28T09:00:00.000Z"
const update = {
  key: "ending:run:run-1",
  weight: "owed",
  event: "failed",
  line: "The copy could not be prepared.",
  door: {
    kind: "automation",
    label: "Evening review",
    automation_ref: "evening-review~t67i40",
    href: "arden:automation/evening-review~t67i40"
  }
} as const
const decodePayload = Schema.decodeUnknownSync(RunDeliveryPayloadSchema)

describe("run delivery payloads", () => {
  it.each([
    ["an ending", { kind: "ending", runId: "run-1" }],
    ["a tell", { kind: "tell", runId: "run-1", n: 2 }],
    ["a met criterion", { kind: "met", runId: "run-1", lineId: 7 }],
    ["an entity event", { kind: "entity", key: "automation-failed:3" }]
  ] as const)("an update from %s decodes", (_name, source) => {
    const payload = { kind: "update", sessionId: "chat-1", source, update, occurredAt: AT }
    expect(decodePayload(payload)).toEqual(payload)
  })

  it("a withdrawn update decodes", () => {
    const payload = {
      kind: "update",
      sessionId: "chat-1",
      source: { kind: "ending", runId: "run-1" },
      update,
      occurredAt: AT,
      withdrawal: { at: AT, reason: "destination_archived" }
    }
    expect(decodePayload(payload)).toEqual(payload)
  })

  it("an update without its line is refused", () => {
    const { line: _line, ...unlined } = update
    expect(() =>
      decodePayload({
        kind: "update",
        sessionId: "chat-1",
        source: { kind: "ending", runId: "run-1" },
        update: unlined,
        occurredAt: AT
      })
    ).toThrow()
  })

  it("a stored result payload still decodes", () => {
    const payload = {
      kind: "result",
      sessionId: "chat-1",
      context: {
        origin: { kind: "chat", session_id: "chat-1", turn_id: "turn-1" },
        task: null
      },
      runIds: ["run-1"],
      questionId: null
    }
    expect(decodePayload(payload)).toEqual(payload)
  })
})

it("a history message keeps the update that opened its turn", () => {
  const message = {
    role: "user",
    content: "Automation failed",
    message_id: "arrival:abc",
    turn_id: "arrival:abc",
    is_meta: true,
    update
  }
  expect(Schema.decodeUnknownSync(HistoryMessageSchema)(message)).toMatchObject({ update })
})
