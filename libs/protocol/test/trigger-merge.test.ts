import { describe, expect, it } from "vitest"
import {
  mergeTriggerInputs,
  type AutomationTrigger,
  type AutomationTriggerInput,
  type TimeTriggerSpec
} from "../src/automations/index.js"

const CONDITION = {
  kind: "compare",
  field: "item.sender",
  op: "contains",
  value: "acme"
} as const
const OLD = { kind: "old", condition: CONDITION } as const
const SENTENCE = { kind: "sentence", sentence: "A recruiter replied" } as const
const ANY = { kind: "any_event" } as const
const NONE = { kind: "none" } as const
const KEPT = { kind: "kept" } as const

const every = (interval: string): TimeTriggerSpec => ({
  type: "time",
  schedule: {
    kind: "interval",
    every: interval,
    days: { kind: "every_day" },
    window: { kind: "all_day" }
  }
})

const STORED = {
  lastId: 4,
  triggers: [
    { id: "t1", ...every("1h") },
    {
      id: "t3",
      type: "event",
      event_type: "email.received",
      condition: OLD,
      run_only_if: SENTENCE
    }
  ] satisfies ReadonlyArray<AutomationTrigger>
}

const edit = (id: string, trigger: Extract<AutomationTriggerInput, { kind: "edit" }>["trigger"]) =>
  ({ kind: "edit", id, trigger }) as const

describe("a trigger list written over the stored one", () => {
  it.each<{
    readonly name: string
    readonly sent: ReadonlyArray<AutomationTriggerInput>
    readonly result: ReturnType<typeof mergeTriggerInputs>
  }>([
    {
      name: "an edit keeps the condition and sentence it marks kept",
      sent: [
        edit("t3", {
          type: "event",
          event_type: "email.received",
          condition: KEPT,
          run_only_if: KEPT
        })
      ],
      result: {
        kind: "ok",
        lastId: 4,
        dropped: [],
        triggers: [
          {
            id: "t3",
            type: "event",
            event_type: "email.received",
            condition: OLD,
            run_only_if: SENTENCE
          }
        ]
      }
    },
    {
      name: "a cleared field is named, and a new trigger takes an id never given",
      sent: [
        edit("t3", {
          type: "event",
          event_type: "email.received",
          condition: NONE,
          run_only_if: KEPT
        }),
        { kind: "new", trigger: { type: "idle", idle_minutes: 10 } }
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
            condition: NONE,
            run_only_if: SENTENCE
          },
          { id: "t5", type: "idle", idle_minutes: 10 }
        ]
      }
    },
    {
      name: "the same trigger sent as new is new, and the write names what it let go",
      sent: [
        {
          kind: "new",
          trigger: {
            type: "event",
            event_type: "email.received",
            condition: NONE,
            run_only_if: ANY
          }
        }
      ],
      result: {
        kind: "ok",
        lastId: 5,
        dropped: [
          { id: "t3", field: "condition", value: CONDITION },
          { id: "t3", field: "run_only_if", value: "A recruiter replied" }
        ],
        triggers: [
          {
            id: "t5",
            type: "event",
            event_type: "email.received",
            condition: NONE,
            run_only_if: ANY
          }
        ]
      }
    },
    {
      name: "a trigger moved to another event keeps nothing of the old one",
      sent: [
        edit("t3", {
          type: "event",
          event_type: "task.changed",
          condition: KEPT,
          run_only_if: KEPT
        })
      ],
      result: {
        kind: "ok",
        lastId: 4,
        dropped: [
          { id: "t3", field: "condition", value: CONDITION },
          { id: "t3", field: "run_only_if", value: "A recruiter replied" }
        ],
        triggers: [
          { id: "t3", type: "event", event_type: "task.changed", condition: NONE, run_only_if: ANY }
        ]
      }
    },
    {
      name: "the id of a deleted trigger is refused as deleted",
      sent: [edit("t4", every("2h"))],
      result: { kind: "deleted_id", id: "t4" }
    },
    {
      name: "an id the Automation never gave is refused",
      sent: [edit("t9", every("2h"))],
      result: { kind: "unknown_id", id: "t9" }
    },
    {
      name: "one id sent twice is refused",
      sent: [edit("t1", every("2h")), edit("t1", every("3h"))],
      result: { kind: "duplicate_id", id: "t1" }
    },
    {
      name: "an app event that keeps an app event the stored trigger lacks is refused",
      sent: [
        edit("t3", {
          type: "event",
          event_type: "mcp.event",
          mcp_event: KEPT,
          condition: KEPT,
          run_only_if: KEPT
        })
      ],
      result: { kind: "missing_app_event", id: "t3" }
    }
  ])("$name", ({ sent, result }) => {
    expect(mergeTriggerInputs(STORED, sent)).toEqual(result)
  })

  it("a trigger moved to another app event keeps nothing of the old one", () => {
    const stored = {
      lastId: 2,
      triggers: [
        {
          id: "t2",
          type: "event",
          event_type: "mcp.event",
          mcp_event: { server: "gmail", event: "message", arguments: {} },
          condition: OLD,
          run_only_if: ANY
        }
      ] satisfies ReadonlyArray<AutomationTrigger>
    }
    expect(
      mergeTriggerInputs(stored, [
        edit("t2", {
          type: "event",
          event_type: "mcp.event",
          mcp_event: { kind: "chosen", server: "gmail", event: "label", arguments: {} },
          condition: KEPT,
          run_only_if: KEPT
        })
      ])
    ).toEqual({
      kind: "ok",
      lastId: 2,
      dropped: [{ id: "t2", field: "condition", value: CONDITION }],
      triggers: [
        {
          id: "t2",
          type: "event",
          event_type: "mcp.event",
          mcp_event: { server: "gmail", event: "label", arguments: {} },
          condition: NONE,
          run_only_if: ANY
        }
      ]
    })
  })

  it("an edit of the same app event keeps its app event and lead it marks kept", () => {
    const stored = {
      lastId: 2,
      triggers: [
        {
          id: "t1",
          type: "event",
          event_type: "mcp.event",
          mcp_event: { server: "gmail", event: "message", arguments: { label: "x" } },
          condition: NONE,
          run_only_if: SENTENCE
        },
        {
          id: "t2",
          type: "event",
          event_type: "event_approaching",
          lead: { kind: "minutes", minutes: 30 },
          condition: NONE,
          run_only_if: ANY
        }
      ] satisfies ReadonlyArray<AutomationTrigger>
    }
    const merged = mergeTriggerInputs(stored, [
      edit("t1", {
        type: "event",
        event_type: "mcp.event",
        mcp_event: KEPT,
        condition: KEPT,
        run_only_if: KEPT
      }),
      edit("t2", {
        type: "event",
        event_type: "event_approaching",
        lead: KEPT,
        condition: KEPT,
        run_only_if: ANY
      })
    ])
    expect(merged).toEqual({ kind: "ok", lastId: 2, dropped: [], triggers: stored.triggers })
  })

  it("gives a new trigger an id no stored trigger holds", () => {
    const stored = {
      lastId: 0,
      triggers: [{ id: "t1", ...every("1h") }] satisfies ReadonlyArray<AutomationTrigger>
    }
    const merged = mergeTriggerInputs(stored, [
      edit("t1", every("1h")),
      { kind: "new", trigger: every("2h") }
    ])
    expect(merged.kind === "ok" ? merged.triggers.map((trigger) => trigger.id) : []).toEqual([
      "t1",
      "t2"
    ])
  })
})
