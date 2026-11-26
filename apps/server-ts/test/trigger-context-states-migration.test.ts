import { Schema } from "effect"
import { expect, it } from "vitest"
import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { todayTriggerContext } from "../src/persistence/migrations/0195_trigger_context_states.js"

const AT = "2026-10-12T09:00:00.000Z"

it("a stored count and event cause decode as tagged states after the migration", () => {
  const migrated = todayTriggerContext({
    source: "coalesced",
    queued_at: AT,
    causes: [
      { source: "count", queued_at: AT, session_id: "s1", through_sequence: null, every_n: 3 },
      { source: "count", queued_at: AT, session_id: "s1", through_sequence: 12, every_n: 3 },
      {
        source: "event",
        queued_at: AT,
        event_type: "task.changed",
        event_key: "1",
        produced_by: null,
        context: {}
      },
      {
        source: "event",
        queued_at: AT,
        event_type: "task.changed",
        event_key: "2",
        produced_by: "automation:7",
        chain_depth: 2,
        context: {}
      }
    ]
  })
  const decoded = Schema.decodeUnknownSync(AutomationTriggerContextSchema)(migrated)
  expect(decoded.source === "coalesced" ? decoded.causes : []).toMatchObject([
    { through: { kind: "unrecorded" } },
    { through: { kind: "message", sequence: 12 } },
    { produced_by: { kind: "outside" }, chain_depth: 0 },
    { produced_by: { kind: "automation", automation_id: "automation:7" }, chain_depth: 2 }
  ])
  expect(todayTriggerContext(migrated)).toEqual(migrated)
})
