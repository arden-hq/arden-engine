import { Effect } from "effect"
import type { Writer } from "./deps.js"
import { storeError } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import { taskUnfinishedSql } from "./task-status-sql.js"

export const queueNextDueAt = Effect.fn("SqliteAutomationStore.nextDueAt")(function* (
  writer: Pick<Writer, "sql" | "run">,
  now: number
) {
  const at = iso(now)
  const rows = yield* writer
    .run(
      writer.sql<{ readonly due: string | null }>`
        SELECT MIN(due) AS due FROM (
          SELECT next_attempt_at AS due FROM automation_event_queue
          WHERE claimed_at IS NULL AND next_attempt_at > ${at}
          UNION ALL
          SELECT lease_expires_at FROM automation_event_queue
          WHERE claimed_at IS NOT NULL AND lease_expires_at > ${at}
          UNION ALL
          SELECT next_run_at FROM scheduled_tasks
          WHERE enabled = 1 AND next_run_at > ${at}
          UNION ALL
          SELECT next_attempt_at FROM space_tasks
          WHERE ${taskUnfinishedSql()} AND next_attempt_at > ${at}
        )
      `
    )
    .pipe(
      Effect.mapError((cause) =>
        storeError(
          "claim",
          "storage",
          "Could not read the next due Automation job",
          undefined,
          cause
        )
      )
    )
  const due = rows[0]?.due
  if (due === null || due === undefined) return undefined
  const dueMs = Date.parse(due)
  return Number.isFinite(dueMs) ? dueMs : undefined
})
