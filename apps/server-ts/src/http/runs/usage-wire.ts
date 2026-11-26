import { contextSize } from "@arden-hq/protocol/chat"
import {
  CALL_METER,
  CONTEXT_WINDOW,
  RUN_MODEL,
  RUN_REASONING,
  RUN_TIMING,
  STAMP,
  TURN_PLACE,
  USAGE_CHAT,
  USAGE_LINK,
  USAGE_SPACE,
  type RunModel,
  type RunStamp,
  type SessionRunUsage,
  type UsageAutomationRow,
  type UsageDailyCell,
  type UsageReport,
  type UsageSpace,
  type UsageTopSession
} from "@arden-hq/protocol/runs"
import { SESSION_NAME } from "@arden-hq/protocol/sessions"
import { providerCost, wireRunUsage } from "../../persistence/runs/stored-result.js"
import type {
  StoredSessionRun,
  StoredUsageAutomationRow,
  StoredUsageDailyCell,
  StoredUsageReport,
  StoredUsageTopSession
} from "../../persistence/usage/report.js"

const usageSpace = (spaceId: string | null, name: string | null): UsageSpace => {
  if (spaceId === null) return { kind: USAGE_SPACE.none }
  return name === null
    ? { kind: USAGE_SPACE.removed, space_id: spaceId }
    : { kind: USAGE_SPACE.space, space_id: spaceId, name }
}

const runModel = (modelId: string | null): RunModel =>
  modelId === null ? { kind: RUN_MODEL.unrecorded } : { kind: RUN_MODEL.model, model_id: modelId }

const stamp = (at: string | null): RunStamp =>
  at === null ? { kind: STAMP.unrecorded } : { kind: STAMP.at, at }

const tokens = (row: {
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
}) => ({
  total: row.total,
  output: row.output,
  cache_read: row.cache_read,
  cache_write: row.cache_write
})

const dailyCell = (row: StoredUsageDailyCell): UsageDailyCell => ({
  day: row.day,
  space: usageSpace(row.space_id, row.space_name),
  origin: row.origin,
  chat:
    row.session_type === null
      ? { kind: USAGE_CHAT.none }
      : { kind: USAGE_CHAT.chat, session_type: row.session_type },
  model: runModel(row.model_id),
  kind: row.kind,
  ...tokens(row),
  cost: providerCost(row.cost),
  runs: row.runs
})

const topSession = (row: StoredUsageTopSession): UsageTopSession => ({
  session_id: row.session_id,
  name:
    row.name === null
      ? { kind: SESSION_NAME.unnamed }
      : { kind: SESSION_NAME.named, name: row.name },
  space: usageSpace(row.space_id, row.space_name),
  session_type: row.session_type,
  ...tokens(row),
  cost: providerCost(row.cost),
  runs: row.runs,
  average_last_input: contextSize(row.average_last_input)
})

const automationRow = (row: StoredUsageAutomationRow): UsageAutomationRow => ({
  automation:
    row.task_id === null
      ? { kind: USAGE_LINK.none }
      : { kind: USAGE_LINK.linked, task_id: row.task_id },
  task:
    row.item_id === null
      ? { kind: USAGE_LINK.none }
      : { kind: USAGE_LINK.linked, item_id: row.item_id },
  space:
    row.space_id === null
      ? { kind: USAGE_LINK.none }
      : { kind: USAGE_LINK.linked, space_id: row.space_id },
  name: row.name,
  destination:
    row.destination === null
      ? { kind: USAGE_LINK.none }
      : { kind: USAGE_LINK.linked, destination: row.destination },
  purpose: row.purpose ?? "unrecorded",
  handler:
    row.handler === null
      ? { kind: USAGE_LINK.none }
      : { kind: USAGE_LINK.linked, handler: row.handler },
  checks: row.checks,
  runs: row.runs,
  unaccounted_runs: row.unaccounted_runs,
  total: row.total,
  cache_read: row.cache_read,
  outcomes: row.outcomes.map((outcome) => ({
    ...outcome,
    outcome: outcome.outcome ?? "unrecorded"
  }))
})

export const wireUsageReport = (report: StoredUsageReport): UsageReport => ({
  days: report.days,
  since: report.since,
  daily: report.daily.map(dailyCell),
  top_sessions: report.top_sessions.map(topSession),
  automations: report.automations.map(automationRow)
})

export const wireSessionRun = (
  run: StoredSessionRun,
  contextWindow: number | null
): SessionRunUsage => ({
  run_id: run.run_id,
  turn_id: run.turn_id,
  turn:
    run.turn_index === null
      ? { kind: TURN_PLACE.unindexed }
      : { kind: TURN_PLACE.indexed, index: run.turn_index },
  status: run.status,
  started_at: run.started_at,
  ended: stamp(run.ended_at),
  model: runModel(run.model_id),
  reasoning:
    run.reasoning_effort === null
      ? { kind: RUN_REASONING.default }
      : { kind: RUN_REASONING.effort, effort: run.reasoning_effort },
  context_window:
    contextWindow === null
      ? { kind: CONTEXT_WINDOW.unknown }
      : { kind: CONTEXT_WINDOW.known, tokens: contextWindow },
  timing:
    run.timing === null ? { kind: RUN_TIMING.untimed } : { kind: RUN_TIMING.timed, ...run.timing },
  calls: run.calls.map((call) => ({
    usage:
      call.usage === null
        ? { kind: CALL_METER.awaiting }
        : { kind: CALL_METER.metered, usage: wireRunUsage(call.usage) },
    admitted: stamp(call.admitted_at),
    responded: stamp(call.responded_at)
  }))
})
