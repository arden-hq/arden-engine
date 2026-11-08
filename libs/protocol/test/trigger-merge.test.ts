import { describe, expect, it } from "vitest"
import { mergeTriggerInputs, type AutomationTrigger } from "../src/automations/index.js"

const CONDITION = { kind: "compare", field: "item.sender", op: "contains", value: "acme" } as const
const STORED = {
  lastId: 4,
  triggers: [
    { id: "t1", type: "time", every: "1h" },
    {
      id: "t3",
      type: "event",
      event_type: "email.received",
      condition: CONDITION,
      run_only_if: "A recruiter replied"
    }
  ] satisfies ReadonlyArray<AutomationTrigger>
}

describe("a trigger list written over the stored one", () => {
  it.each([
    {
      name: "a trigger sent by id keeps the condition and sentence it leaves out",
      sent: [{ id: "t3", type: "event", event_type: "email.received" }],
      result: {
        kind: "ok",
        lastId: 4,
        dropped: [],
        triggers: [
          {
            id: "t3",
            type: "event",
            event_type: "email.received",
            condition: CONDITION,
            run_only_if: "A recruiter replied"
          }
        ]
      }
    },
    {
      name: "null clears a kept field and names it, and a new trigger takes an id never given",
      sent: [
        { id: "t3", type: "event", event_type: "email.received", condition: null },
        { type: "idle", idle_minutes: 10 }
      ],
      result: {
        kind: "ok",
        lastId: 5,
        dropped: [{ id: "t3", field: "condition", value: CONDITION }],
        triggers: [
          {
            id: "t3",
            type: "event",
            event_type: "email.received",
            run_only_if: "A recruiter replied"
          },
          { id: "t5", type: "idle", idle_minutes: 10 }
        ]
      }
    },
    {
      name: "the same trigger sent without its id is new, and the write names what it let go",
      sent: [{ type: "event", event_type: "email.received" }],
      result: {
        kind: "ok",
        lastId: 5,
        dropped: [
          { id: "t3", field: "condition", value: CONDITION },
          { id: "t3", field: "run_only_if", value: "A recruiter replied" }
        ],
        triggers: [{ id: "t5", type: "event", event_type: "email.received" }]
      }
    },
    {
      name: "a trigger moved to another event keeps nothing of the old one",
      sent: [{ id: "t3", type: "event", event_type: "task.changed" }],
      result: {
        kind: "ok",
        lastId: 4,
        dropped: [
          { id: "t3", field: "condition", value: CONDITION },
          { id: "t3", field: "run_only_if", value: "A recruiter replied" }
        ],
        triggers: [{ id: "t3", type: "event", event_type: "task.changed" }]
      }
    },
    {
      name: "the id of a deleted trigger is refused as deleted",
      sent: [{ id: "t4", type: "time", every: "2h" }],
      result: { kind: "deleted_id", id: "t4" }
    },
    {
      name: "an id the Automation never gave is refused",
      sent: [{ id: "t9", type: "time", every: "2h" }],
      result: { kind: "unknown_id", id: "t9" }
    },
    {
      name: "one id sent twice is refused",
      sent: [
        { id: "t1", type: "time", every: "2h" },
        { id: "t1", type: "time", every: "3h" }
      ],
      result: { kind: "duplicate_id", id: "t1" }
    }
  ] as const)("$name", ({ sent, result }) => {
    expect(mergeTriggerInputs(STORED, sent)).toEqual(result)
  })
})
