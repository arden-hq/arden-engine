import { Schema } from "effect"
import type { AutomationRunStatus } from "./contracts.js"

/**
 * How one Automation occurrence ended: the one stored record of it
 * (`automation_runs.outcome`), written once when it settles. Every reader (the
 * history, recent statuses, the Inbox, auto-pause, the cooldown, `run_ended`,
 * `automation_finished`, notifications and push) reads this, never status,
 * disposition or the agent's report again.
 *
 * - `finished`: it ran and did something.
 * - `no_change`: it ran (or had nothing to run on) and changed nothing.
 * - `needs_you`: it stopped on a question to you.
 * - `blocked`: its agent reported it could not finish (`report` blocked).
 * - `failed`: it failed.
 * - `interrupted`: an agent's run stopped by a restart; a Worker attempt only.
 * - `cancelled`: it was stopped before it ended.
 * - `superseded`: its Automation changed or turned off before its run started.
 * - `skipped:<reason>`: it ended before any run (`prefilter`: its "Run only if"
 *   said no; `space_review_gate`: a Space review had nothing new). A skip is never
 *   a run: only the history lists it.
 */
export const AUTOMATION_RUN_OUTCOMES = [
  "finished",
  "no_change",
  "needs_you",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
  "superseded",
  "skipped:prefilter",
  "skipped:space_review_gate"
] as const

export type AutomationRunOutcome = (typeof AUTOMATION_RUN_OUTCOMES)[number]

export const AutomationRunOutcomeSchema = Schema.Literals(AUTOMATION_RUN_OUTCOMES)

/** Whether the run did its work and ended: it finished, found no change, reported
 *  `needs_you` or `blocked`, or was skipped. A failed, interrupted, cancelled or
 *  superseded run did not run. */
export const ranOutcome = (outcome: AutomationRunOutcome): boolean => {
  switch (outcome) {
    case "finished":
    case "no_change":
    case "needs_you":
    case "blocked":
    case "skipped:prefilter":
    case "skipped:space_review_gate":
      return true
    case "failed":
    case "interrupted":
    case "cancelled":
    case "superseded":
      return false
  }
}

/** The status a run shows for its outcome. A skip shows completed with its `skipped`
 *  record; a superseded run never started, so it shows cancelled, never failed. */
export const runStatusOf = (outcome: AutomationRunOutcome): AutomationRunStatus => {
  switch (outcome) {
    case "finished":
    case "no_change":
    case "skipped:prefilter":
    case "skipped:space_review_gate":
      return "completed"
    case "needs_you":
    case "blocked":
      return "blocked"
    case "failed":
      return "failed"
    case "interrupted":
      return "interrupted"
    case "cancelled":
    case "superseded":
      return "cancelled"
  }
}
