import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** A Memory change no longer wakes a Space review, so a review job no longer subscribes to
 * `wiki.changed`. Rows such a subscription already queued would each be claimed once and end
 * with nothing to act on. This removes them: every waiting, unclaimed queue row of a
 * `space_review` job whose only causes are Memory changes is deleted, and a row with other causes
 * too keeps those causes and loses the Memory ones. A row a run has claimed, and every other
 * job's rows, are left as they are. */
const up = (database: DatabaseSync): void => {
  const rows = database
    .prepare(`SELECT queue.id, queue.context FROM automation_event_queue AS queue
      JOIN scheduled_tasks AS job ON job.task_id = queue.task_id
      WHERE job.purpose = 'space_review' AND queue.claimed_at IS NULL
        AND json_extract(queue.context, '$.automation_run_id') IS NULL
        AND (json_extract(queue.context, '$.trigger_context_snapshot.event_type') = 'wiki.changed'
          OR EXISTS (SELECT 1 FROM json_each(queue.context, '$.trigger_context_snapshot.causes') AS cause
            WHERE json_extract(cause.value, '$.event_type') = 'wiki.changed'))`)
    .all()
  const remove = database.prepare("DELETE FROM automation_event_queue WHERE id = ?")
  const rewrite = database.prepare("UPDATE automation_event_queue SET context = ? WHERE id = ?")
  for (const row of rows) {
    const context = JSON.parse(String(row["context"]))
    const snapshot = context.trigger_context_snapshot
    const kept =
      snapshot.source === "coalesced"
        ? snapshot.causes.filter((cause: { event_type?: unknown }) => !fromMemory(cause))
        : []
    if (kept.length === 0) {
      remove.run(Number(row["id"]))
      continue
    }
    const { triggering_change: _memory, ...rest } = context
    const batch = rest.event_batch
    const next = {
      ...rest,
      trigger_context_snapshot: kept.length === 1 ? kept[0] : { ...snapshot, causes: kept },
      ...(batch === undefined ? {} : withoutMemoryEvents(batch))
    }
    rewrite.run(JSON.stringify(next), Number(row["id"]))
  }
}

const fromMemory = (cause: { event_type?: unknown }): boolean => cause.event_type === "wiki.changed"

/** The row's event batch with its Memory events gone, or no batch when none is left. */
const withoutMemoryEvents = (batch: {
  events: ReadonlyArray<{ event_type?: unknown }>
  overflow?: ReadonlyArray<{ event_type?: unknown }>
}) => {
  const [first, ...rest] = [...batch.events, ...(batch.overflow ?? [])].filter(
    (event) => !fromMemory(event)
  )
  if (first === undefined) return { event_batch: undefined }
  const events = batch.events.filter((event) => !fromMemory(event))
  const overflow = (batch.overflow ?? []).filter((event) => !fromMemory(event))
  return {
    event_batch:
      events.length > 0
        ? { ...batch, events, overflow }
        : { ...batch, events: [first], overflow: rest }
  }
}

export const memoryWakesLeaveReviews: Migration = {
  version: 162,
  name: "memory_wakes_leave_reviews",
  foreignKeys: { kind: "enforced" },
  up
}
