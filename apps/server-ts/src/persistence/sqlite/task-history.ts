import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import type { SessionLifecycleEvents } from "../sessions/events.js"
import { recordTaskDone, recordTaskFailed } from "./entity-events.js"
import { readRunCause } from "./run-cause.js"

export interface AddedTaskHistory {
  readonly event_id: number
  readonly item_id: string
  readonly run_ref: string | null
}

export const journalTaskHistory = Effect.fn("TaskHistory.journal")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"],
  added: ReadonlyArray<AddedTaskHistory>
) {
  for (const row of added) {
    const cause =
      row.run_ref === null
        ? { produced_by: null, chain_depth: 0 }
        : yield* readRunCause(sql, row.run_ref)
    yield* sessionEvents.appendEventInTransaction({
      type: "task_history_added",
      item_id: row.item_id,
      event_id: row.event_id,
      ...cause
    })
    yield* recordTaskDone(sql, sessionEvents, row.event_id)
    yield* recordTaskFailed(sql, sessionEvents, row.event_id)
  }
})
