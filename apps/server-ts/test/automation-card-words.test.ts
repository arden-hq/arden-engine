import { expect, it } from "vitest"
import type { AutomationTrigger } from "@arden-hq/protocol/automations"
import { cardTriggerWords } from "../src/tools/automation-tool-text.js"
import type { ToolTrigger } from "../src/tools/automation-tool-trigger-schema.js"
import {
  cardTriggers,
  newTriggerInput,
  toolTriggerInput
} from "../src/tools/automation-tool-triggers.js"

const STORED: ReadonlyArray<AutomationTrigger> = [
  {
    id: "t1",
    type: "event",
    event_type: "mcp.event",
    mcp_event: { server: "gh", event: "pr", arguments: {} },
    run_only_if: { kind: "sentence", sentence: "z" },
    condition: { kind: "none" }
  },
  {
    id: "t2",
    type: "event",
    event_type: "email.received",
    run_only_if: { kind: "sentence", sentence: "w" },
    condition: { kind: "none" }
  }
]

const storedApp = (id: string) => {
  const trigger = STORED.find((candidate) => candidate.id === id)
  return trigger?.type === "event" && trigger.event_type === "mcp.event"
    ? trigger.mcp_event
    : undefined
}

it("a create card names a refused app event as before", () => {
  const sent: ReadonlyArray<ToolTrigger> = [
    { type: "event", event_type: "mcp.event", run_only_if: "y" },
    {
      type: "event",
      event_type: "event_approaching",
      lead_minutes: 120,
      mcp_event: { server: "a", event: "b" }
    }
  ]
  expect(
    cardTriggerWords(
      [],
      cardTriggers(sent, newTriggerInput, () => undefined)
    )
  ).toBe('App event, run only if: "y" or 2 hours before each calendar event')
})

it("an update card keeps what a refused app event edit keeps, as before", () => {
  const sent: ReadonlyArray<ToolTrigger> = [
    { id: "t1", type: "event", event_type: "mcp.event", mcp_event: null },
    { id: "t2", type: "event", event_type: "mcp.event" }
  ]
  expect(cardTriggerWords(STORED, cardTriggers(sent, toolTriggerInput, storedApp))).toBe(
    'App event, run only if: "z" or App event'
  )
})
