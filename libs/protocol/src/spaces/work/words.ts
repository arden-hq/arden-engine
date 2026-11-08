import type { SpaceTask, SpaceTaskStatus } from "./contracts.js"

/** The Task is not finished: being worked (`open`) or postponed (`deferred`).
 *  The SQL twin is `taskUnfinishedSql`; "being worked now" is `open` alone
 *  (`taskOpenSql`). */
export const isTaskUnfinished = (status: SpaceTaskStatus): boolean =>
  status === "open" || status === "deferred"

type ActivityFacts = Pick<SpaceTask, "activity" | "waiting_on" | "stop_reason">

/** What an open Task is doing now, for the model's reads of the board, the Space
 *  and one Task; undefined while it is idle. `clipReason` bounds a stop reason
 *  where room is short. */
export const taskActivityWords = (
  task: ActivityFacts,
  clipReason: (reason: string) => string = (reason) => reason
): string | undefined => {
  switch (task.activity) {
    case "needs_you":
      return "asking you"
    case "on_hold":
      return "on hold until you resume it"
    case "working":
      return "running now"
    case "waiting":
      return task.waiting_on === "external"
        ? "waiting on someone else"
        : "waiting for the user to act"
    case "stopped":
      return `stopped: ${clipReason(task.stop_reason ?? "no reason was recorded")}`
    case "idle":
      return undefined
  }
}
