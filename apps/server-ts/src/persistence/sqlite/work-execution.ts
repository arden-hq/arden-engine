import type { SpaceTask } from "@arden-hq/protocol/spaces/work"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { WorkStore, WorkStoreError, TaskExecutionReceipt } from "../work/store.js"
import { workActivitySql } from "./work-activity.js"
import { workError } from "./work-records.js"

export const makeWorkExecution = (sql: SqlClient.SqlClient): WorkStore["Service"]["execution"] =>
  Effect.fn("Work.execution")(function* (itemId): Effect.fn.Return<
    TaskExecutionReceipt,
    WorkStoreError
  > {
    const rows = yield* sql<{
      readonly status: SpaceTask["status"]
      readonly activity: SpaceTask["activity"]
      readonly next_attempt_at: string | null
      readonly can_run: number
      readonly queued: number
    }>`SELECT task.status, ${workActivitySql(sql, sql`task`)} AS activity,
        task.next_attempt_at,
        (task.owner = 'worker' AND (task.space_id IS NULL
          OR space.archived_at IS NULL)) AS can_run,
        EXISTS (SELECT 1 FROM scheduled_tasks AS job JOIN automation_event_queue AS pending
          ON pending.task_id = job.task_id WHERE job.owner_task_id = task.item_id
            AND job.enabled = 1) AS queued
      FROM space_tasks AS task LEFT JOIN spaces AS space ON space.space_id = task.space_id
      WHERE task.item_id = ${itemId}`.pipe(
      Effect.mapError((cause) => workError("storage", "Could not read Task execution", cause))
    )
    const task = rows[0]
    if (task === undefined) return yield* workError("not_found", "Task not found")
    if (task.status !== "open") return { kind: "inactive", state: task.status }
    if (task.activity === "working") return { kind: "working" }
    if (task.activity === "needs_you" || task.activity === "on_hold")
      return { kind: "inactive", state: task.activity }
    if (task.can_run && task.next_attempt_at !== null)
      return { kind: "scheduled", at: task.next_attempt_at }
    if (task.can_run && task.queued) return { kind: "queued" }
    if (task.activity !== "idle") return { kind: "inactive", state: task.activity }
    return { kind: "saved" }
  })
