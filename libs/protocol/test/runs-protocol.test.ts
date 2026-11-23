import { expect, it } from "vitest"

import { ProtocolError } from "@arden-hq/protocol"
import { runDecoders } from "@arden-hq/protocol/runs"

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
  const late = { ...completedRun, status: "cancelled", late_result_at: "2026-08-30T10:00:03Z" }
  expect(runDecoders.detail(late).status).toBe("cancelled")
  expect(() => runDecoders.detail({ ...late, late_result_at: null })).toThrow(ProtocolError)
  expect(() => runDecoders.detail({ ...late, result: null })).toThrow(ProtocolError)
})

it("tells a reported cost from an unknown one in a Run's result", () => {
  const reported = {
    ...completedRun,
    result: {
      ...completedRun.result,
      usage: { ...completedRun.result.usage, cost: 0.0004 },
      cost: 0.0004
    }
  }
  expect(runDecoders.detail(reported).result).toEqual(reported.result)
  const { cost: _cost, ...unknown } = completedRun.result
  const unpriced = { ...completedRun, result: unknown }
  expect(runDecoders.detail(unpriced).result).toEqual(unknown)
  expect(() =>
    runDecoders.detail({
      ...completedRun,
      result: { ...completedRun.result, usage: { ...completedRun.result.usage, cost: -1 } }
    })
  ).toThrow(ProtocolError)
})
