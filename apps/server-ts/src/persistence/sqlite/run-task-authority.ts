import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { WorkStoreError } from "../work/store.js"
import { assertRunTaskBinding } from "./run-context.js"
import { runMayActSql } from "./run-liveness.js"

export const assertRunTaskAuthority = Effect.fn("RunContext.assertTaskAuthority")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  itemId?: string
) {
  const { taskItemId } = yield* assertRunTaskBinding(sql, runId, itemId)
  const acting = yield* sql`SELECT 1 FROM chat_runs AS run
    WHERE run.run_id = ${runId} AND ${runMayActSql(sql, "run")}`.pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({ reason: "storage", message: "Could not inspect Run authority", cause })
    )
  )
  if (acting.length === 0) {
    return yield* new WorkStoreError({
      reason: "conflict",
      message: "This Run no longer has authority for that action"
    })
  }
  return taskItemId
})
