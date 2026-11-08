/**
 * A detached script's status. A script runs until it settles; `queued`,
 * `needs_input` and `cancelling` appear only in results stored before
 * scripts had one record (C1, 2026-10).
 */
export const WORKFLOW_STATUSES = [
  "queued",
  "running",
  "needs_input",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "needs_attention"
] as const

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number]

/** Statuses of a script that has not settled. */
export const LIVE_WORKFLOW_STATUSES = [
  "queued",
  "running",
  "needs_input",
  "cancelling"
] as const satisfies ReadonlyArray<WorkflowStatus>

/** Statuses a script ends in. */
export const SETTLED_WORKFLOW_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "needs_attention"
] as const satisfies ReadonlyArray<WorkflowStatus>

export type SettledWorkflowStatus = (typeof SETTLED_WORKFLOW_STATUSES)[number]

const liveStatuses: ReadonlySet<string> = new Set(LIVE_WORKFLOW_STATUSES)

export const isLiveWorkflowStatus = (status: WorkflowStatus): boolean => liveStatuses.has(status)

/** A status word from outside; undefined for a word this build does not know. */
export const parseWorkflowStatus = (value: unknown): WorkflowStatus | undefined =>
  WORKFLOW_STATUSES.find((status) => status === value)
