import type { RuntimeRunStatus } from "../chat/runtime.js"
export { RUN_STATUS } from "../chat/runtime.js"
import type { EndedRunDetail, RunDetail } from "./contracts.js"
import { RuntimeRunStatusSchema } from "../common/schema.js"

const runStatusIsTerminal = {
  pending: false,
  running: false,
  interrupted: true,
  error: true,
  cancelled: true,
  completed: true
} as const satisfies Record<RuntimeRunStatus, boolean>

const runStatusIsForeground = {
  pending: true,
  running: true,
  interrupted: false,
  error: false,
  cancelled: false,
  completed: false
} as const satisfies Record<RuntimeRunStatus, boolean>

const runStatusIsExecuting = {
  pending: false,
  running: true,
  interrupted: false,
  error: false,
  cancelled: false,
  completed: false
} as const satisfies Record<RuntimeRunStatus, boolean>

type RunStatusesWhere<Table extends Record<RuntimeRunStatus, boolean>, Flag extends boolean> = {
  [Status in RuntimeRunStatus]: Table[Status] extends Flag ? Status : never
}[RuntimeRunStatus]

export type TerminalRunStatus = RunStatusesWhere<typeof runStatusIsTerminal, true>
export type ActiveRunStatus = RunStatusesWhere<typeof runStatusIsTerminal, false>
export type ForegroundRunStatus = RunStatusesWhere<typeof runStatusIsForeground, true>
export type ExecutingRunStatus = RunStatusesWhere<typeof runStatusIsExecuting, true>

const isTerminalMember = (status: RuntimeRunStatus): status is TerminalRunStatus =>
  runStatusIsTerminal[status]
const isActiveMember = (status: RuntimeRunStatus): status is ActiveRunStatus =>
  !runStatusIsTerminal[status]

export const TERMINAL_RUN_STATUSES: ReadonlyArray<TerminalRunStatus> =
  RuntimeRunStatusSchema.literals.filter(isTerminalMember)

export const ACTIVE_RUN_STATUSES: ReadonlyArray<ActiveRunStatus> =
  RuntimeRunStatusSchema.literals.filter(isActiveMember)

export const FOREGROUND_RUN_STATUSES: ReadonlyArray<ForegroundRunStatus> =
  RuntimeRunStatusSchema.literals.filter(
    (status): status is ForegroundRunStatus => runStatusIsForeground[status]
  )

export const EXECUTING_RUN_STATUSES: ReadonlyArray<ExecutingRunStatus> =
  RuntimeRunStatusSchema.literals.filter(
    (status): status is ExecutingRunStatus => runStatusIsExecuting[status]
  )

const terminalRunStatuses: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES)
const activeRunStatuses: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUSES)
const foregroundRunStatuses: ReadonlySet<string> = new Set(FOREGROUND_RUN_STATUSES)
const executingRunStatuses: ReadonlySet<string> = new Set(EXECUTING_RUN_STATUSES)

export const isTerminalRunStatus = (
  status: string | null | undefined
): status is TerminalRunStatus => status != null && terminalRunStatuses.has(status)

export const isActiveRunStatus = (status: string | null | undefined): status is ActiveRunStatus =>
  status != null && activeRunStatuses.has(status)

export const isForegroundRunStatus = (
  status: string | null | undefined
): status is ForegroundRunStatus => status != null && foregroundRunStatuses.has(status)

export const isExecutingRunStatus = (
  status: string | null | undefined
): status is ExecutingRunStatus => status != null && executingRunStatuses.has(status)

export const runHasEnded = (detail: RunDetail): detail is EndedRunDetail =>
  isTerminalRunStatus(detail.status)
