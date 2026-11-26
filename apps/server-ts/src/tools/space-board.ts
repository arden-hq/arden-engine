import { TASK_ACTIVITY, TASK_STATUS } from "@arden-hq/protocol/spaces/work"
import { activityWords } from "../persistence/work/public.js"
import type { SpaceDetailRecord } from "../persistence/spaces/store.js"

type BoardTask = SpaceDetailRecord["work"]["work_items"][number]

interface BoardEntry {
  readonly task: BoardTask
  readonly comments: ReadonlyArray<SpaceDetailRecord["work"]["comments"][number]>
  readonly attachments: ReadonlyArray<SpaceDetailRecord["work"]["attachments"][number]>
}

export const boardRows = (
  detail: SpaceDetailRecord
): {
  readonly entries: ReadonlyArray<BoardEntry>
  readonly liveCount: number
  readonly settledShown: number
} => {
  const comments = new Map<string, Array<(typeof detail.work.comments)[number]>>()
  for (const comment of detail.work.comments) {
    const current = comments.get(comment.item_id) ?? []
    if (current.length < 3) current.push(comment)
    comments.set(comment.item_id, current)
  }
  const attachments = new Map<string, Array<(typeof detail.work.attachments)[number]>>()
  for (const attachment of detail.work.attachments) {
    const current = attachments.get(attachment.item_id) ?? []
    current.push(attachment)
    attachments.set(attachment.item_id, current)
  }
  const live = detail.work.work_items.filter((item) => item.status === TASK_STATUS.open)
  const deferred = detail.work.work_items.filter((item) => item.status === TASK_STATUS.deferred)
  const settled = detail.work.work_items
    .filter((item) => item.status === TASK_STATUS.done || item.status === TASK_STATUS.cancelled)
    .slice(0, 5)
  const entries = [...live, ...deferred, ...settled].map((task) => ({
    task,
    comments: comments.get(task.item_id) ?? [],
    attachments: attachments.get(task.item_id) ?? []
  }))
  return { entries, liveCount: live.length, settledShown: settled.length }
}

export const taskStateWords = (task: SpaceDetailRecord["work"]["work_items"][number]): string[] => {
  if (task.status !== TASK_STATUS.open) return []
  const next = task.next_attempt_at === null ? [] : [`next check ${task.next_attempt_at}`]
  const words = activityWords(task)
  const nextShown =
    task.activity === TASK_ACTIVITY.waiting ||
    task.activity === TASK_ACTIVITY.stopped ||
    words === undefined
  return [...(words === undefined ? [] : [words]), ...(nextShown ? next : [])]
}
