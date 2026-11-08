import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { QuotaClass, QuotaPauseReason } from "../../models/plan-limits.js"
import { WorkStoreError } from "../work/store.js"
import { activeRunStatusList } from "./status-sets.js"

const failure = (message: string, cause?: unknown) =>
  new WorkStoreError({ reason: "conflict", message, ...(cause === undefined ? {} : { cause }) })

export const runQuotaClass = Effect.fn("PlanQuota.runClass")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{
    readonly kind: string | null
    readonly purpose: string | null
    readonly automation_id: string | null
  }>`
    SELECT json_extract(run.metadata_json, '$.run_context.origin.kind') AS kind, job.purpose,
      job.task_id AS automation_id
    FROM chat_runs AS run
    LEFT JOIN scheduled_tasks AS job
      ON job.task_id = json_extract(run.metadata_json, '$.automation.task_id')
    WHERE run.run_id = ${runId}`.pipe(
    Effect.mapError((cause) => failure("Could not classify the Run for plan limits", cause))
  )
  const row = rows[0]
  if (row === undefined) return yield* failure("This Run no longer exists")
  return {
    quotaClass: quotaClass(row.kind, row.purpose),
    automationId: row.automation_id ?? undefined
  }
})

const quotaClass = (kind: string | null, purpose: string | null): QuotaClass => {
  if (purpose === "task_execution") return "interactive"
  if (purpose !== null) return "background"
  return kind === "automation" || kind === "space" ? "background" : "interactive"
}

export const parkRunForQuota = Effect.fn("PlanQuota.park")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly runId: string
    readonly reason: QuotaPauseReason
    readonly until: string
    readonly timestamp: string
  }
) {
  const parked = yield* sql`
    UPDATE chat_runs
    SET status = 'pending',
        updated_at = ${input.timestamp},
        metadata_json = json_set(metadata_json, '$.quota_pause',
          json_object('reason', ${input.reason}, 'until', ${input.until}))
    WHERE run_id = ${input.runId} AND status IN ${activeRunStatusList}
    RETURNING run_id`.pipe(
    Effect.mapError((cause) => failure("Could not pause the Run for its plan limit", cause))
  )
  if (parked.length === 0) return yield* failure("This Run has stopped")
})

export const releaseQuotaPauses = Effect.fn("PlanQuota.release")(function* (
  sql: SqlClient.SqlClient,
  { reason }: { readonly reason?: QuotaPauseReason } = {}
) {
  yield* sql`
    UPDATE chat_runs
    SET metadata_json = json_remove(metadata_json, '$.quota_pause')
    WHERE status = 'pending' AND json_extract(metadata_json, '$.quota_pause') IS NOT NULL
      AND ${reason === undefined ? sql`TRUE` : sql`json_extract(metadata_json, '$.quota_pause.reason') = ${reason}`}`.pipe(
    Effect.mapError((cause) => failure("Could not release runs paused on a plan limit", cause))
  )
})
