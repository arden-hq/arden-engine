import { Schema } from "effect"
import { expect, it } from "vitest"
import { AutomationTriggerSchema } from "@arden-hq/protocol/effect/automations"
import { todayTrigger } from "../src/persistence/migrations/0196_trigger_states.js"
import { triggerRecord } from "../src/persistence/automations/trigger-record.js"

const STORED = [
  { id: "t1", type: "time", at: "09:30", on: "2026-12-01" },
  { id: "t2", type: "time", at: "08:00", days: "weekdays" },
  { id: "t3", type: "time", at: "07:05" },
  { id: "t4", type: "time", days: "mon,wed", every: "30m", start: "09:00", end: "17:00" },
  { id: "t5", type: "time", every: "2h", end: "20:00" },
  { id: "t6", type: "event", event_type: "event_approaching", lead_minutes: 0 },
  {
    id: "t7",
    type: "event",
    event_type: "mcp.event",
    mcp_event: { server: "linear", event: "issue.created", arguments: { team: "A" } },
    run_only_if: "Bugs only"
  },
  {
    id: "t8",
    type: "event",
    event_type: "email.received",
    condition: { kind: "compare", field: "email.from", op: "exists" }
  },
  { id: "t9", type: "idle", idle_minutes: 10 }
]

it("every stored trigger decodes as tagged states after the migration and keeps its record", () => {
  const migrated = STORED.map(todayTrigger)
  const decoded = Schema.decodeUnknownSync(Schema.Array(AutomationTriggerSchema))(migrated)
  expect(decoded.map(triggerRecord)).toEqual(STORED)
  expect(migrated.map(todayTrigger)).toEqual(migrated)
})
