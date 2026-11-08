import { expect, it } from "vitest"

import { ProtocolError } from "@arden-hq/protocol"
import { isRunTerminalEvent } from "@arden-hq/protocol/chat"
import {
  MODEL_CALL_KINDS,
  RUN_PROGRESS_EVENT_TYPES,
  runDecoders,
  usageGroup
} from "@arden-hq/protocol/runs"

const completedRun = {
  version: 1,
  run_id: "run/alpha",
  session_id: "session/alpha",
  turn_id: "turn/alpha",
  status: "completed",
  started_at: "2026-08-30T10:00:00Z",
  updated_at: "2026-08-30T10:00:02Z",
  ended_at: "2026-08-30T10:00:02Z",
  stop_reason: "end_turn",
  last_event_sequence: 5,
  model_id: "fixture-model",
  reasoning_effort: null,
  client_id: "client-alpha",
  result: {
    text: "The answer",
    data: { verdict: "supported" },
    usage: {
      prompt: 10,
      completion: 4,
      total: 14,
      cache_read: 0,
      cache_write: 0
    },
    cost: 0.01,
    duration_ms: 2000,
    tool_time_ms: 250,
    steps: 2,
    last_input_tokens: 10
  },
  error: null,
  late_result_at: null
} as const

it("decodes an ordered durable Run event page", () => {
  const page = {
    run_id: "run/alpha",
    session_id: "session/alpha",
    trace_removed_at: null,
    events: [
      {
        sequence: 1,
        created_at: "2026-08-30T10:00:00Z",
        event: {
          type: "RUN_STARTED",
          run_id: "run/alpha",
          session_id: "session/alpha",
          turn_id: "turn/alpha"
        }
      },
      {
        sequence: 5,
        created_at: "2026-08-30T10:00:02Z",
        event: {
          type: "RUN_FINISHED",
          run_id: "run/alpha",
          session_id: "session/alpha",
          turn_id: "turn/alpha"
        }
      }
    ],
    next_after_sequence: 5,
    has_more: false
  } as const

  expect(runDecoders.eventPage(page)).toEqual(page)
  expect(() =>
    runDecoders.eventPage({
      ...page,
      events: [...page.events].reverse()
    })
  ).toThrow(ProtocolError)
})

it("exposes late outcomes without reviving cancelled Runs", () => {
  const late = { ...completedRun, status: "cancelled", late_result_at: "2026-08-30T10:00:03Z" }
  expect(runDecoders.detail(late).status).toBe("cancelled")
  expect(() => runDecoders.detail({ ...late, late_result_at: null })).toThrow(ProtocolError)
  expect(() => runDecoders.detail({ ...late, result: null })).toThrow(ProtocolError)
})

it("counts every terminal Run event as a Run progress change", () => {
  for (const type of ["RUN_FINISHED", "RUN_ERROR", "run_cancelled"]) {
    expect(isRunTerminalEvent({ type })).toBe(true)
    expect(RUN_PROGRESS_EVENT_TYPES.has(type)).toBe(true)
  }
})

it("folds every model-call kind into the owner's four usage groups", () => {
  const upkeep = [
    "chat_title",
    "run_activity",
    "letter_subject",
    "chat_triage",
    "focus_offer",
    "space_overview",
    "space_instructions",
    "automation_description",
    "recipe_draft",
    "capture",
    "item_routing",
    "compaction",
    "composer_shortcut"
  ]
  const safety = ["helper_review", "claim_check"]
  const byGroup = (origin: "user" | "automation") => {
    const groups: Record<string, Array<string>> = {}
    for (const kind of MODEL_CALL_KINDS) (groups[usageGroup(kind, origin)] ??= []).push(kind)
    return groups
  }
  expect(byGroup("user")).toEqual({
    chats: ["chat"],
    upkeep,
    safety,
    automations: ["automation_prefilter", "space_review_gate"]
  })
  expect(byGroup("automation")).toEqual({
    automations: ["chat", "automation_prefilter", "space_review_gate"],
    upkeep,
    safety
  })
})
