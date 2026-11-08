import {
  ACTIVE_RUN_STATUSES,
  EXECUTING_RUN_STATUSES,
  FOREGROUND_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type TerminalRunStatus
} from "@arden-hq/protocol/runs"
import { Statement } from "effect/unstable/sql"
import type { StoredProcedure } from "../browser-procedures/model.js"

const statusList = (statuses: ReadonlyArray<string>): Statement.Fragment =>
  Statement.fragment([Statement.literal(`(${statuses.map((status) => `'${status}'`).join(", ")})`)])

export const activeRunStatusList = statusList(ACTIVE_RUN_STATUSES)
export const terminalRunStatusList = statusList(TERMINAL_RUN_STATUSES)
export const failedRunStatusList = statusList([
  "error",
  "interrupted"
] as const satisfies ReadonlyArray<TerminalRunStatus>)
export const modelTurnRunStatusList = statusList(EXECUTING_RUN_STATUSES)
export const foregroundRunStatusList = statusList(FOREGROUND_RUN_STATUSES)

export const TOOL_STATUSES = ["running", "ready", "completed", "paused", "uncertain"] as const
export type ToolStatus = (typeof TOOL_STATUSES)[number]
export const liveToolStatusList = statusList([
  "running",
  "ready",
  "paused"
] as const satisfies ReadonlyArray<ToolStatus>)
export const unresolvedToolStatusList = statusList([
  "running",
  "ready",
  "paused",
  "uncertain"
] as const satisfies ReadonlyArray<ToolStatus>)

export const resultToolStatusList = statusList([
  "completed",
  "uncertain"
] as const satisfies ReadonlyArray<ToolStatus>)
export const outToolStatusList = statusList([
  "running",
  "uncertain"
] as const satisfies ReadonlyArray<ToolStatus>)
export const eligibleBrowserProcedureStatusList = statusList([
  "candidate",
  "accepted"
] as const satisfies ReadonlyArray<StoredProcedure["status"]>)
export const waitingToolStatusList = statusList([
  "ready",
  "paused"
] as const satisfies ReadonlyArray<ToolStatus>)
export const touchingToolStatusList = statusList([
  "running",
  "paused",
  "uncertain"
] as const satisfies ReadonlyArray<ToolStatus>)

export const openDeferredCallStatusList = statusList(["pending", "approved"])
export const followUpRecordableStatusList = statusList(["approved", "rejected"])
export const answeredApprovalStatusList = statusList(["approved", "rejected"])
export const openProposalStatusList = statusList(["offered", "held"])
export const answeredProposalStatusList = statusList(["accepted", "rejected"])
export const endedUnsuccessfullyAutomationRunStatusList = statusList([
  "failed",
  "cancelled",
  "interrupted"
])
export const erroredRunStatusList = statusList(["error"])
export const unfinishedRequestStatusList = statusList(["queued", "running"])
const runColumn = (alias: string | undefined, name: string): string =>
  alias === undefined ? name : `${alias}.${name}`

export const restartCutRunSql = (alias?: string): Statement.Fragment =>
  Statement.fragment([
    Statement.literal(
      `(${runColumn(alias, "status")} = 'interrupted' AND ${runColumn(alias, "stop_reason")} IS 'server_restart')`
    )
  ])

export const stoppedRunSql = (alias?: string): Statement.Fragment =>
  Statement.fragment([
    Statement.literal(
      `(${runColumn(alias, "status")} IN ('cancelled', 'error') OR (${runColumn(alias, "status")} = 'interrupted' AND ${runColumn(alias, "stop_reason")} IS NOT 'server_restart'))`
    )
  ])
