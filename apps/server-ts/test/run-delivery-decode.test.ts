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
  role: ROLE.interaction,
  kind: "event",
  from: { source: "harness", id: "update", name: { kind: "unnamed" } },
  to: { kind: "unaddressed" },
  preview: { kind: "unpreviewed" },
  caused_by: { kind: "untraced" },
  content: "Automation failed",
  message_id: "arrival:abc",
  turn_id: "arrival:abc",
  seq: 1,
  created_at: AT,
  client: { kind: "untracked" },
  applied: { kind: "unstamped" },
  context: [],
  reply_to: [],
  compact: false,
  forwarded_from: { kind: "original" },
  from_chat: { kind: "direct" },
  connection: { kind: "none" },
  communication: { kind: "none" },
  agent_result: { kind: "none" },
  automation: { kind: "none" }
}
const decodeMessage = Schema.decodeUnknownSync(HistoryMessageSchema)

it("a history message keeps the update that opened its turn", () => {
  expect(decodeMessage({ ...arrival, update: { kind: "update", update } })).toMatchObject({
    update: { kind: "update", update }
  })
})

it("a history message refuses an update without its line", () => {
  const { line: _line, ...unlined } = update
  expect(() => decodeMessage({ ...arrival, update: { kind: "update", update: unlined } })).toThrow()
})
