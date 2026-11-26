import { expect, it } from "vitest"

import { ProtocolError } from "@arden-hq/protocol"
import { runDecoders } from "@arden-hq/protocol/runs"

const terminalResult = {
  text: "The answer",
  data: { verdict: "supported" },
  usage: {
    prompt: 10,
    completion: 4,
    total: 14,
    cache_read: 0,
    cache_write: 0,
    cost: { kind: "reported", usd: 0.01 }
  },
  duration_ms: 2000,
  tool_time_ms: 250,
  steps: 2,
  context: { kind: "measured", input_tokens: 10 }
} as const

const completedRun = {
  version: 1,
  run_id: "run/alpha",
  session_id: "session/alpha",
  turn_id: "turn/alpha",
  status: "completed",
  started_at: "2026-08-30T10:00:00Z",
  updated_at: "2026-08-30T10:00:02Z",
  ended_at: "2026-08-30T10:00:02Z",
  stop_reason: { kind: "stated", reason: "end_turn" },
  events: { kind: "through", sequence: 5 },
  model: { kind: "model", model_id: "fixture-model" },
  reasoning: { kind: "default" },
  client: { kind: "client", client_id: "client-alpha" },
  local_instructions: [],
  memory_context: [],
  result: { kind: "on_time", result: terminalResult },
  failure: { kind: "none" }
} as const

it("decodes an ordered durable Run event page", () => {
  const page = {
    run_id: "run/alpha",
    session_id: "session/alpha",
    trace: { kind: "kept" },
    events: [
      {
        sequence: 1,
        created_at: "2026-08-30T10:00:00Z",
        event: {
          type: "RUN_STARTED",
          run_id: "run/alpha",
          session_id: "session/alpha",
          turn_id: "turn/alpha",
          causes: []
        }
      },
      {
        sequence: 5,
        created_at: "2026-08-30T10:00:02Z",
        event: {
          type: "RUN_FINISHED",
          run_id: "run/alpha",
          session_id: "session/alpha",
          turn_id: "turn/alpha",
          usage: { kind: "unmetered" },
          context: { kind: "unmeasured" },
          message_count: 0
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
  const [first, last] = page.events
  expect(() =>
    runDecoders.eventPage({
      ...page,
      events: [first, { ...last, sequence: 1 }],
      next_after_sequence: 1
    })
  ).toThrow(ProtocolError)
  expect(() => runDecoders.eventPage({ ...page, next_after_sequence: 4 })).toThrow(ProtocolError)
})

it("exposes late outcomes without reviving cancelled Runs", () => {
  const late = {
    ...completedRun,
    status: "cancelled",
    result: { kind: "late", result: terminalResult, at: "2026-08-30T10:00:03Z" }
  }
  expect(runDecoders.detail(late).status).toBe("cancelled")
  expect(() =>
    runDecoders.detail({ ...late, result: { kind: "on_time", result: terminalResult } })
  ).toThrow(ProtocolError)
  expect(() =>
    runDecoders.detail({ ...completedRun, status: "running", ended_at: undefined })
  ).not.toThrow()
  expect(() =>
    runDecoders.detail({ ...completedRun, status: "error", failure: { kind: "none" } })
  ).toThrow(ProtocolError)
})

it("tells a reported cost from an unreported one in a Run's result", () => {
  const unpriced = {
    ...completedRun,
    result: {
      kind: "on_time",
      result: {
        ...terminalResult,
        usage: { ...terminalResult.usage, cost: { kind: "unreported" } }
      }
    }
  }
  expect(runDecoders.detail(unpriced)).toEqual(unpriced)
  expect(() =>
    runDecoders.detail({
      ...completedRun,
      result: {
        kind: "on_time",
        result: {
          ...terminalResult,
          usage: { ...terminalResult.usage, cost: { kind: "reported", usd: -1 } }
        }
      }
    })
  ).toThrow(ProtocolError)
})
