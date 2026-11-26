import { Schema } from "effect"
import { expect, it } from "vitest"
import { AutomationEventSchema } from "@arden-hq/protocol/effect/events"
import { todayLifecycleEvent } from "../src/persistence/migrations/0199_lifecycle_event_links.js"

const STORED = [
  { type: "automation_finished", task_id: "a1", purpose: "system", result: null, error: "boom" },
  {
    type: "automation_finished",
    task_id: "a1",
    outcome: "finished",
    run_id: "r1",
    run_session_id: "s1"
  },
  {
    type: "record_told",
    key: "ending:r1",
    record: "ending",
    status: "finished",
    shown: true,
    unread: true,
    title: "Daily",
    text: "Done",
    chat_session_id: "s1",
    automation_id: null,
    item_id: "i1"
  },
  { type: "entity_changed", kind: "space", id: null },
  { type: "entity_changed", kind: "task", id: "i1" },
  { type: "question_changed", session_id: "s1", question_id: "q1", run_id: "r1", item_id: null },
  { type: "task_visibility_changed", space_id: null, item_id: "i1" },
  { type: "work_changed", space_id: "sp1", item_id: "i1", change: "status" }
]

it("every stored lifecycle event decodes with its links as tagged states after the migration", () => {
  const migrated = STORED.map(todayLifecycleEvent)
  const decoded = migrated.map((event) => Schema.decodeUnknownSync(AutomationEventSchema)(event))
  expect(decoded).toMatchObject([
    { outcome: "failed", run_chat: { kind: "none" } },
    { outcome: "finished", run_chat: { kind: "chat", session_id: "s1" } },
    {
      chat: { kind: "chat", session_id: "s1" },
      automation: { kind: "none" },
      task: { kind: "task", item_id: "i1" }
    },
    { target: { kind: "many" } },
    { target: { kind: "one", id: "i1" } },
    { task: { kind: "none" } },
    { space: { kind: "none" } },
    { space: { kind: "space", space_id: "sp1" } }
  ])
  expect(migrated.map(todayLifecycleEvent)).toEqual(migrated)
})
