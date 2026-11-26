import { TASK_BLOCK, TASK_STOP, type SpaceTask, type SpaceTaskStatus } from "./contracts.js"

/** The Task is not finished: being worked (`open`) or postponed (`deferred`).
 *  The SQL twin is `taskUnfinishedSql`; "being worked now" is `open` alone
 *  (`taskOpenSql`). */
export const isTaskUnfinished = (status: SpaceTaskStatus): boolean =>
  status === "open" || status === "deferred"

type ActivityFacts = Pick<SpaceTask, "activity" | "block">

export const taskActivityWords = (
  task: ActivityFacts,
  clipReason: (reason: string) => string = (reason) => reason
): string | undefined => {
  switch (task.activity.kind) {
    case "needs_you":
      return "asking you"
    case "on_hold":
      return "on hold until you resume it"
    case "working":
      return "running now"
    case "waiting":
      return task.block.kind === TASK_BLOCK.blocked && task.block.waiting_on === "external"
        ? "waiting on someone else"
        : "waiting for the user to act"
    case "stopped":
      return `stopped: ${clipReason(
        task.activity.stop.kind === TASK_STOP.recorded
          ? task.activity.stop.reason
          : "no reason was recorded"
      )}`
    case "idle":
      return undefined
  }
}
