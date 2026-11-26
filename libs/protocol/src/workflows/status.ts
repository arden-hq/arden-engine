export const WORKFLOW_STATUS = {
  queued: "queued",
  running: "running",
  needs_input: "needs_input",
  cancelling: "cancelling",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  needs_attention: "needs_attention"
} as const

export type WorkflowStatus = (typeof WORKFLOW_STATUS)[keyof typeof WORKFLOW_STATUS]

export const LIVE_WORKFLOW_STATUSES = [
  WORKFLOW_STATUS.queued,
  WORKFLOW_STATUS.running,
  WORKFLOW_STATUS.needs_input,
  WORKFLOW_STATUS.cancelling
] as const satisfies ReadonlyArray<WorkflowStatus>

export const SETTLED_WORKFLOW_STATUSES = [
  WORKFLOW_STATUS.succeeded,
  WORKFLOW_STATUS.failed,
  WORKFLOW_STATUS.cancelled,
  WORKFLOW_STATUS.needs_attention
] as const satisfies ReadonlyArray<WorkflowStatus>

export type SettledWorkflowStatus = (typeof SETTLED_WORKFLOW_STATUSES)[number]

const liveStatuses: ReadonlySet<string> = new Set(LIVE_WORKFLOW_STATUSES)

export const isLiveWorkflowStatus = (status: WorkflowStatus): boolean => liveStatuses.has(status)

export const parseWorkflowStatus = (value: unknown): WorkflowStatus | undefined =>
  Object.values(WORKFLOW_STATUS).find((status) => status === value)
