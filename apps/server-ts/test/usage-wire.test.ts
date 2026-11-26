import { Schema } from "effect"
import { expect, it } from "vitest"
import {
  PlanLimitsReportSchema,
  SessionUsageReportSchema,
  UsageReportSchema
} from "@arden-hq/protocol/effect/runs"
import { wireSessionRun, wireUsageReport } from "../src/http/runs/usage-wire.js"
import { wirePlanLimits } from "../src/http/runs/plan-limits-wire.js"

const tokens = { total: 10, output: 2, cache_read: 1, cache_write: 0 }

it("answers the usage report and a chat's Runs in shapes the protocol decodes", () => {
  const report = wireUsageReport({
    days: 1,
    since: "2026-11-24",
    daily: [
      {
        day: "2026-11-24",
        space_id: "s1",
        space_name: null,
        origin: "user",
        session_type: null,
        model_id: null,
        kind: "chat",
        ...tokens,
        runs: 1
      },
      {
        day: "2026-11-24",
        space_id: null,
        space_name: null,
        origin: "automation",
        session_type: "chat",
        model_id: "m",
        kind: "chat",
        ...tokens,
        cost: 0.5,
        runs: 2
      }
    ],
    top_sessions: [
      {
        session_id: "c1",
        name: null,
        space_id: "s2",
        space_name: "Home",
        session_type: "chat",
        ...tokens,
        runs: 1,
        average_last_input: null
      }
    ],
    automations: [
      {
        task_id: "a1",
        item_id: null,
        space_id: null,
        name: "Digest",
        destination: null,
        purpose: null,
        handler: null,
        checks: 1,
        runs: 1,
        unaccounted_runs: 0,
        total: 10,
        cache_read: 1,
        outcomes: [{ outcome: null, checks: 1, runs: 1, unaccounted_runs: 0, ...tokens }]
      }
    ]
  })
  expect(Schema.decodeUnknownSync(UsageReportSchema)(report)).toEqual(report)
  expect(report.daily.map((cell) => [cell.space, cell.chat, cell.model, cell.cost])).toEqual([
    [
      { kind: "removed", space_id: "s1" },
      { kind: "none" },
      { kind: "unrecorded" },
      { kind: "unreported" }
    ],
    [
      { kind: "none" },
      { kind: "chat", session_type: "chat" },
      { kind: "model", model_id: "m" },
      { kind: "reported", usd: 0.5 }
    ]
  ])
  expect(report.automations[0]?.outcomes[0]?.outcome).toBe("unrecorded")
  const run = wireSessionRun(
    {
      run_id: "r1",
      turn_id: "t1",
      turn_index: null,
      status: "running",
      started_at: "2026-11-24T00:00:00.000Z",
      ended_at: null,
      model_id: "m",
      reasoning_effort: null,
      timing: null,
      calls: [{ usage: null, admitted_at: "2026-11-24T00:00:00.000Z", responded_at: null }]
    },
    null
  )
  const session = { session_id: "c1", runs: [run] }
  expect(Schema.decodeUnknownSync(SessionUsageReportSchema)(session)).toEqual(session)
})

it("answers plan limits with tagged plan name, credits and limit time", () => {
  const report = wirePlanLimits({
    plans: [
      {
        provider: "openai-codex",
        plan: null,
        credits: { kind: "limited", available: true, balance: null },
        windows: [
          {
            used_percent: 40,
            window_seconds: 18_000,
            resets_at: "2026-11-24T05:00:00.000Z",
            pace: {
              limit_percent: 100,
              elapsed_percent: 20,
              on_pace_percent: 20,
              ahead: true,
              reaches_limit_at: null
            }
          }
        ],
        observed_at: "2026-11-24T00:00:00.000Z"
      },
      {
        provider: "openai-codex",
        plan: "pro",
        credits: null,
        windows: [],
        observed_at: "2026-11-24T00:00:00.000Z"
      }
    ]
  })
  expect(Schema.decodeUnknownSync(PlanLimitsReportSchema)(report)).toEqual(report)
  expect(report.plans.map((plan) => [plan.plan, plan.credits])).toEqual([
    [{ kind: "unnamed" }, { kind: "limited", available: true, balance: { kind: "unreported" } }],
    [{ kind: "named", name: "pro" }, { kind: "unreported" }]
  ])
})
