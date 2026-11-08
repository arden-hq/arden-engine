import { Effect } from "effect"

import type { AutomationTriggerEvent, TaskFeedRow } from "../../persistence/automations/model.js"
import type { AutomationEventProducer } from "../event-producer.js"

type TaskChange = "created" | "changed" | "blocked"

const taskChange = (kind: string): TaskChange | undefined => {
  switch (kind) {
    case "created":
      return "created"
    case "blocked":
    case "on_hold":
    case "block_loop":
      return "blocked"
    case "scheduled":
    case "retry_scheduled":
      return undefined
    default:
      return "changed"
  }
}

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
        space_id: row.spaceId ?? "",
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
    if (record.event.type !== "task_history_added") return []
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
