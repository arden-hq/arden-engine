import {
  ACTIVE_RUN_STATUSES,
  RUN_STATUS,
  EXECUTING_RUN_STATUSES,
  FOREGROUND_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type TerminalRunStatus
} from "@arden-hq/protocol/runs"
import { Statement } from "effect/unstable/sql"
import type { StoredProcedure } from "../browser-procedures/model.js"

export const statusSqlList = (statuses: ReadonlyArray<string>): string =>
  `(${statuses.map((status) => `'${status}'`).join(", ")})`

const statusList = (statuses: ReadonlyArray<string>): Statement.Fragment =>
  Statement.fragment([Statement.literal(statusSqlList(statuses))])

export const activeRunStatusList = statusList(ACTIVE_RUN_STATUSES)
export const terminalRunStatusList = statusList(TERMINAL_RUN_STATUSES)
export const failedRunStatusList = statusList([
  "error",
  "interrupted"
] as const satisfies ReadonlyArray<TerminalRunStatus>)
export const modelTurnRunStatusList = statusList(EXECUTING_RUN_STATUSES)
export const foregroundRunStatusList = statusList(FOREGROUND_RUN_STATUSES)

export const STORED_RUN_STATUS = { ...RUN_STATUS, failed: "failed" } as const
export type StoredRunStatus = (typeof STORED_RUN_STATUS)[keyof typeof STORED_RUN_STATUS]

export const TOOL_STATUS = {
  running: "running",
  ready: "ready",
  completed: "completed",
  paused: "paused",
  uncertain: "uncertain"
} as const
export const TOOL_STATUSES = Object.values(TOOL_STATUS)
export type ToolStatus = (typeof TOOL_STATUS)[keyof typeof TOOL_STATUS]
export const liveToolStatusList = statusList([
  "running",
  "ready",
  "paused"
] as const satisfies ReadonlyArray<ToolStatus>)
export const UNRESOLVED_TOOL_STATUSES = [
  "running",
  "ready",
  "paused",
  "uncertain"
] as const satisfies ReadonlyArray<ToolStatus>
export const unresolvedToolStatusList = statusList(UNRESOLVED_TOOL_STATUSES)

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
const REFUSED_PROPOSAL_STATUSES = ["rejected", "expired"] as const
export const refusedProposalStatusList = statusList(REFUSED_PROPOSAL_STATUSES)
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
