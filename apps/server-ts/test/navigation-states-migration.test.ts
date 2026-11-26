import { Schema } from "effect"
import { expect, it } from "vitest"
import { NavigationRequestedEventSchema } from "@arden-hq/protocol/effect/events"
import { todayNavigation } from "../src/persistence/migrations/0198_navigation_states.js"

const event = (destination: object, extra: object = {}) => ({
  type: "navigation_requested",
  origin_session_id: "chat-1",
  label: "Open it",
  destination,
  ...extra
})

const STORED = [
  event({ kind: "session", session_id: "s1" }, { mode: "offer", tool_call_id: "call-1" }),
  event({ kind: "session", session_id: "s1", turn_id: "t1" }),
  event({ kind: "settings" }),
  event({ kind: "settings", tab: "models" }),
  event({ kind: "automation", task_id: null }),
  event({ kind: "automation", task_id: "a1" }),
  event({ kind: "memory", path: "notes/a.md" }),
  event({ kind: "work", item_id: "i1" }),
  event({ kind: "work" })
]

it("every stored navigation request decodes as tagged states after the migration", () => {
  const migrated = STORED.map(todayNavigation)
  const decoded = migrated.map((value) =>
    Schema.decodeUnknownSync(NavigationRequestedEventSchema)(value)
  )
  expect(
    decoded.map(({ destination, mode, asked_by }) => ({ destination, mode, asked_by }))
  ).toEqual([
    {
      destination: { kind: "session", session_id: "s1", turn: { kind: "latest" } },
      mode: "offer",
      asked_by: { kind: "tool_call", tool_call_id: "call-1" }
    },
    {
      destination: { kind: "session", session_id: "s1", turn: { kind: "turn", turn_id: "t1" } },
      mode: "open",
      asked_by: { kind: "untracked" }
    },
    {
      destination: { kind: "settings", tab: { kind: "general" } },
      mode: "open",
      asked_by: { kind: "untracked" }
    },
    {
      destination: { kind: "settings", tab: { kind: "tab", tab_id: "models" } },
      mode: "open",
      asked_by: { kind: "untracked" }
    },
    {
      destination: { kind: "automation", target: { kind: "list" } },
      mode: "open",
      asked_by: { kind: "untracked" }
    },
    {
      destination: { kind: "automation", target: { kind: "automation", task_id: "a1" } },
      mode: "open",
      asked_by: { kind: "untracked" }
    },
    {
      destination: { kind: "memory", target: { kind: "page", path: "notes/a.md" } },
      mode: "open",
      asked_by: { kind: "untracked" }
    },
    { destination: { kind: "task", item_id: "i1" }, mode: "open", asked_by: { kind: "untracked" } },
    { destination: { kind: "home" }, mode: "open", asked_by: { kind: "untracked" } }
  ])
  expect(migrated.map(todayNavigation)).toEqual(migrated)
})
