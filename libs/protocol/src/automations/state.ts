import {
  AUTOMATION_RUN_STATUS,
  type Automation,
  type AutomationRunStatus,
  type AutomationWaitingOn
} from "./contracts.js"
import { AutomationActivitySchema, AutomationLastRunSchema } from "./projection-schema.js"

export const AUTOMATION_STATE = {
  asking_connection: "asking_connection",
  asking_approval: "asking_approval",
  running: "running",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
  stopped: "stopped",
  completed: "completed",
  never_run: "never_run"
} as const

export type AutomationState = (typeof AUTOMATION_STATE)[keyof typeof AUTOMATION_STATE]

type AutomationFacts = Pick<Automation, "activity" | "recent_statuses" | "last_run">

const WAITING_STATE: Record<AutomationWaitingOn, AutomationState> = {
  approval: AUTOMATION_STATE.asking_approval,
  connection: AUTOMATION_STATE.asking_connection
}

export const automationState = (automation: AutomationFacts): AutomationState =>
  AutomationActivitySchema.match(automation.activity, {
    waiting: ({ on }) => WAITING_STATE[on],
    running: (): AutomationState => AUTOMATION_STATE.running,
    idle: () => latestRunState(automation)
  })

const latestRunState = (automation: AutomationFacts): AutomationState => {
  const latest: AutomationRunStatus | undefined = automation.recent_statuses[0]
  switch (latest) {
    case AUTOMATION_RUN_STATUS.failed:
      return AUTOMATION_STATE.failed
    case AUTOMATION_RUN_STATUS.blocked:
      return AUTOMATION_STATE.blocked
    case AUTOMATION_RUN_STATUS.cancelled:
      return AUTOMATION_STATE.cancelled
    case AUTOMATION_RUN_STATUS.interrupted:
      return AUTOMATION_STATE.stopped
    case AUTOMATION_RUN_STATUS.completed:
    case AUTOMATION_RUN_STATUS.running:
    case undefined:
      return AutomationLastRunSchema.guards.ran(automation.last_run)
        ? AUTOMATION_STATE.completed
        : AUTOMATION_STATE.never_run
  }
}

export const AUTOMATION_STATE_WORDS: Record<AutomationState, string> = {
  asking_connection: "reconnect to resume",
  asking_approval: "approve to resume",
  running: "running",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
  stopped: "stopped",
  completed: "completed",
  never_run: "never run"
}

export const automationEnabledWord = (enabled: boolean): "On" | "Paused" =>
  enabled ? "On" : "Paused"
