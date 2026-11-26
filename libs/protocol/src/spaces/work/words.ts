import {
  SPACE_TASK_WAITING_ON,
  TASK_ACTIVITY,
  TASK_BLOCK,
  TASK_STATUS,
  TASK_STOP,
  type SpaceTask,
  type SpaceTaskStatus,
  type UnfinishedTaskStatus
} from "./contracts.js"

export const isTaskUnfinished = (status: SpaceTaskStatus): status is UnfinishedTaskStatus =>
  status === TASK_STATUS.open || status === TASK_STATUS.deferred

type ActivityFacts = Pick<SpaceTask, "activity" | "block">

export const taskActivityWords = (
  task: ActivityFacts,
  clipReason: (reason: string) => string = (reason) => reason
): string | undefined => {
  switch (task.activity.kind) {
    case TASK_ACTIVITY.needs_you:
      return "asking you"
    case TASK_ACTIVITY.on_hold:
      return "on hold until you resume it"
    case TASK_ACTIVITY.working:
      return "running now"
    case TASK_ACTIVITY.waiting:
      return task.block.kind === TASK_BLOCK.blocked &&
        task.block.waiting_on === SPACE_TASK_WAITING_ON.external
        ? "waiting on someone else"
        : "waiting for the user to act"
    case TASK_ACTIVITY.stopped:
      return `stopped: ${clipReason(
        task.activity.stop.kind === TASK_STOP.recorded
          ? task.activity.stop.reason
          : "no reason was recorded"
      )}`
    case TASK_ACTIVITY.idle:
      return undefined
  }
}
