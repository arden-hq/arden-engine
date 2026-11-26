import { isSpaceTaskEventType } from "@arden-hq/protocol/effect/spaces/work"
import type { SpaceTaskEventType } from "@arden-hq/protocol/spaces/work"
import { INTERNAL_LIFECYCLE_EVENT } from "../../persistence/sessions/internal-events.js"
import { Effect } from "effect"

import type { AutomationTriggerEvent, TaskFeedRow } from "../../persistence/automations/model.js"
import type { AutomationEventProducer } from "../event-producer.js"

type TaskChange = "created" | "changed" | "blocked"

const TASK_CHANGE: Readonly<Record<SpaceTaskEventType, TaskChange | undefined>> = {
  created: "created",
  updated: "changed",
  scheduled: undefined,
  blocked: "blocked",
  unblocked: "changed",
  done: "changed",
  cancelled: "changed",
  reopened: "changed",
  on_hold: "blocked",
  block_loop: "blocked",
  reported: "changed",
  failed: "changed",
  retry_scheduled: undefined,
  stalled: "changed",
  progress: "changed",
  completed: "changed",
  inference_undone: "changed",
  owner_changed: "changed"
}

const taskChange = (kind: string): TaskChange | undefined =>
  isSpaceTaskEventType(kind) ? TASK_CHANGE[kind] : "changed"

const taskChangedEvent = (row: TaskFeedRow): AutomationTriggerEvent | undefined => {
  const change = taskChange(row.kind)
  if (change === undefined) return undefined
  const link = `arden:task/${encodeURIComponent(row.itemId)}`
  return {
    eventType: "task.changed",
    eventKey: String(row.eventId),
    producedBy: row.producedBy ?? null,
    chainDepth: row.chainDepth,
    context: {
      task: {
        change,
        item_id: row.itemId,
        key: row.key,
        text: row.text,
        status: row.status,
        blocked: row.blocked,
        space: row.spaceName ?? "",
        ...(row.spaceId === undefined ? {} : { space_id: row.spaceId }),
        summary: row.summary,
        link
      }
    }
  }
}

export const taskEventProducer: AutomationEventProducer<"task.changed"> = {
  eventType: "task.changed",
  source: { kind: "feed" },
  fromJournal: Effect.fnUntraced(function* (record, read) {
    if (record.event.type !== INTERNAL_LIFECYCLE_EVENT.taskHistoryAdded) return []
    const cause = record.event
    const row = yield* read.taskHistory(cause.event_id)
    const event =
      row === undefined
        ? undefined
        : taskChangedEvent({
            ...row,
            producedBy: cause.produced_by ?? undefined,
            chainDepth: cause.chain_depth
          })
    return event === undefined ? [] : [{ event }]
  }),
  failureMessage: "Task Automation trigger failed"
}
