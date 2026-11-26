import type { AppDestination, RuntimeRunStatus } from "@arden-hq/protocol"
import type { AutomationRunOutcome } from "@arden-hq/protocol/automations"
import type { ModelCallKind } from "@arden-hq/protocol/runs"
import type { StoredRunUsage } from "../runs/stored-result.js"

type StoredSessionType = "chat" | "channel" | "agent"

export interface StoredUsageDailyCell {
  readonly day: string
  readonly space_id: string | null
  readonly space_name: string | null
  readonly origin: "user" | "automation"
  readonly session_type: StoredSessionType | null
  readonly model_id: string | null
  readonly kind: ModelCallKind
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly cost?: number
  readonly runs: number
}

export interface StoredUsageTopSession {
  readonly session_id: string
  readonly name: string | null
  readonly space_id: string | null
  readonly space_name: string | null
  readonly session_type: StoredSessionType
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly cost?: number
  readonly runs: number
  readonly average_last_input: number | null
}

type StoredUsagePurpose = "user_automation" | "space_review" | "task_execution" | "system"

export interface StoredUsageAutomationOutcome {
  readonly outcome: AutomationRunOutcome | null
  readonly checks: number
  readonly runs: number
  readonly unaccounted_runs: number
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
}

export interface StoredUsageAutomationRow {
  readonly task_id: string | null
  readonly item_id: string | null
  readonly space_id: string | null
  readonly name: string
  readonly destination: AppDestination | null
  readonly purpose: StoredUsagePurpose | null
  readonly handler: string | null
  readonly checks: number
  readonly runs: number
  readonly unaccounted_runs: number
  readonly total: number
  readonly cache_read: number
  readonly outcomes: ReadonlyArray<StoredUsageAutomationOutcome>
}

export interface StoredUsageReport {
  readonly days: number
  readonly since: string
  readonly daily: ReadonlyArray<StoredUsageDailyCell>
  readonly top_sessions: ReadonlyArray<StoredUsageTopSession>
  readonly automations: ReadonlyArray<StoredUsageAutomationRow>
}

interface StoredModelCall {
  readonly usage: StoredRunUsage | null
  readonly admitted_at: string | null
  readonly responded_at: string | null
}

interface StoredRunTiming {
  readonly duration_ms: number
  readonly tool_time_ms: number
  readonly steps: number
}

export interface StoredSessionRun {
  readonly run_id: string
  readonly turn_id: string
  readonly turn_index: number | null
  readonly status: RuntimeRunStatus
  readonly started_at: string
  readonly ended_at: string | null
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly timing: StoredRunTiming | null
  readonly calls: ReadonlyArray<StoredModelCall>
}
