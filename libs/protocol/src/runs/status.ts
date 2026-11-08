import type { RuntimeRunStatus } from "../chat/runtime.js"
import { RuntimeRunStatusSchema } from "../common/schema.js"

/** Whether a Run in this status has ended. A new status fails compilation here until it is placed. */
const runStatusIsTerminal = {
  pending: false,
  running: false,
  interrupted: true,
  error: true,
  cancelled: true,
  completed: true
} as const satisfies Record<RuntimeRunStatus, boolean>

/** Whether the owner is still waiting on the Run in the chat (not handed to the background). */
const runStatusIsForeground = {
  pending: true,
  running: true,
  interrupted: false,
  error: false,
  cancelled: false,
  completed: false
} as const satisfies Record<RuntimeRunStatus, boolean>

/** Whether the Run has started and has not ended; a `pending` Run has not started. */
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

/** Runs that have ended: `completed`, `interrupted`, `error`, `cancelled`. */
export const TERMINAL_RUN_STATUSES: ReadonlyArray<TerminalRunStatus> =
  RuntimeRunStatusSchema.literals.filter(isTerminalMember)

/** Runs that still own their Session: `pending`, `running`. */
export const ACTIVE_RUN_STATUSES: ReadonlyArray<ActiveRunStatus> =
  RuntimeRunStatusSchema.literals.filter(isActiveMember)

/** Runs the chat still shows as in progress: `pending`, `running`. */
export const FOREGROUND_RUN_STATUSES: ReadonlyArray<ForegroundRunStatus> =
  RuntimeRunStatusSchema.literals.filter(
    (status): status is ForegroundRunStatus => runStatusIsForeground[status]
  )

/** Runs that have started and not ended: `running`. */
export const EXECUTING_RUN_STATUSES: ReadonlyArray<ExecutingRunStatus> =
  RuntimeRunStatusSchema.literals.filter(
    (status): status is ExecutingRunStatus => runStatusIsExecuting[status]
  )

const terminalRunStatuses: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES)
const activeRunStatuses: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUSES)
const foregroundRunStatuses: ReadonlySet<string> = new Set(FOREGROUND_RUN_STATUSES)
const executingRunStatuses: ReadonlySet<string> = new Set(EXECUTING_RUN_STATUSES)

/** True only for a known terminal status; unknown text is neither terminal nor active. */
export const isTerminalRunStatus = (
  status: string | null | undefined
): status is TerminalRunStatus => status != null && terminalRunStatuses.has(status)

/** True only for a known active status; unknown text is neither terminal nor active. */
export const isActiveRunStatus = (status: string | null | undefined): status is ActiveRunStatus =>
  status != null && activeRunStatuses.has(status)

/** True only for a known foreground status; unknown text is not foreground. */
export const isForegroundRunStatus = (
  status: string | null | undefined
): status is ForegroundRunStatus => status != null && foregroundRunStatuses.has(status)

/** True only for a known executing status; unknown text is not executing. */
export const isExecutingRunStatus = (
  status: string | null | undefined
): status is ExecutingRunStatus => status != null && executingRunStatuses.has(status)
