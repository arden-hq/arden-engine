import type { Automation, AutomationRunStatus } from "./contracts.js"

/** What an Automation is doing now, by its latest facts. `paused` (the enabled
 *  flag) is not a rung: a surface decides where Paused ranks against the rest. */
export type AutomationState =
  | "asking_connection"
  | "asking_approval"
  | "running"
  | "failed"
  | "blocked"
  | "cancelled"
  | "stopped"
  | "completed"
  | "never_run"

type AutomationFacts = Pick<
  Automation,
  "waiting_on" | "running_since" | "recent_statuses" | "last_run_at"
>

/** The one reading of an Automation's waiting, running and latest run. A
 *  cancelled latest run is `cancelled`, never `completed`. */
export const automationState = (automation: AutomationFacts): AutomationState => {
  if (automation.waiting_on === "connection") return "asking_connection"
  if (automation.waiting_on === "approval") return "asking_approval"
  if (automation.running_since != null) return "running"
  const latest: AutomationRunStatus | undefined = automation.recent_statuses[0]
  switch (latest) {
    case "failed":
      return "failed"
    case "blocked":
      return "blocked"
    case "cancelled":
      return "cancelled"
    case "interrupted":
      return "stopped"
    case "completed":
    case "running":
    case undefined:
      return automation.last_run_at ? "completed" : "never_run"
  }
}

/** The owner's word for each state. */
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

/** The word for the enabled flag, for the owner and the model alike. */
export const automationEnabledWord = (enabled: boolean): "On" | "Paused" =>
  enabled ? "On" : "Paused"
