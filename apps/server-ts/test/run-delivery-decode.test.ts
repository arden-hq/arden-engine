import { ROLE } from "@arden-hq/std/message-vocabulary"
import { HistoryMessageSchema } from "@arden-hq/protocol/effect/chat"
import { Schema } from "effect"
import { expect, it } from "vitest"
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

it("an update without its line is refused", () => {
  const { line: _line, ...unlined } = update
  expect(() =>
    Schema.decodeUnknownSync(RunDeliveryPayloadSchema)({
      kind: "update",
      sessionId: "chat-1",
      source: { kind: "ending", runId: "run-1" },
      update: unlined,
      occurredAt: AT
    })
  ).toThrow()
})

const arrival = {
  role: ROLE.user,
  content: "Automation failed",
  message_id: "arrival:abc",
  turn_id: "arrival:abc",
  is_meta: true
}
const decodeMessage = Schema.decodeUnknownSync(HistoryMessageSchema)

it("a history message keeps the update that opened its turn", () => {
  expect(decodeMessage({ ...arrival, update })).toMatchObject({ update })
})

it("a history message refuses an update without its line", () => {
  const { line: _line, ...unlined } = update
  expect(() => decodeMessage({ ...arrival, update: unlined })).toThrow()
})
