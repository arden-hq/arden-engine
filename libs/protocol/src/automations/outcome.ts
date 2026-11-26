import { Schema } from "effect"
import { AUTOMATION_RUN_STATUS, type AutomationRunStatus } from "./contracts.js"

export const AUTOMATION_RUN_OUTCOME = {
  finished: "finished",
  no_change: "no_change",
  needs_you: "needs_you",
  blocked: "blocked",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "cancelled",
  superseded: "superseded",
  skipped_prefilter: "skipped:prefilter",
  skipped_space_review_gate: "skipped:space_review_gate"
} as const

export type AutomationRunOutcome =
  (typeof AUTOMATION_RUN_OUTCOME)[keyof typeof AUTOMATION_RUN_OUTCOME]

export const AUTOMATION_RUN_OUTCOMES = Object.values(AUTOMATION_RUN_OUTCOME)

export const AutomationRunOutcomeSchema = Schema.Literals(AUTOMATION_RUN_OUTCOMES)

const RUN_STATUS_OF_OUTCOME: Record<AutomationRunOutcome, AutomationRunStatus> = {
  finished: AUTOMATION_RUN_STATUS.completed,
  no_change: AUTOMATION_RUN_STATUS.completed,
  "skipped:prefilter": AUTOMATION_RUN_STATUS.completed,
  "skipped:space_review_gate": AUTOMATION_RUN_STATUS.completed,
  needs_you: AUTOMATION_RUN_STATUS.blocked,
  blocked: AUTOMATION_RUN_STATUS.blocked,
  failed: AUTOMATION_RUN_STATUS.failed,
  interrupted: AUTOMATION_RUN_STATUS.interrupted,
  cancelled: AUTOMATION_RUN_STATUS.cancelled,
  superseded: AUTOMATION_RUN_STATUS.cancelled
}

const RAN_OUTCOME: Record<AutomationRunOutcome, boolean> = {
  finished: true,
  no_change: true,
  needs_you: true,
  blocked: true,
  "skipped:prefilter": true,
  "skipped:space_review_gate": true,
  failed: false,
  interrupted: false,
  cancelled: false,
  superseded: false
}

export const ranOutcome = (outcome: AutomationRunOutcome): boolean => RAN_OUTCOME[outcome]

export const runStatusOf = (outcome: AutomationRunOutcome): AutomationRunStatus =>
  RUN_STATUS_OF_OUTCOME[outcome]
