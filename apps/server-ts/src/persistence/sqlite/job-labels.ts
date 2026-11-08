import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"

export const renameOwnedJob = Effect.fn("JobLabels.rename")(function* (
  sql: SqlClient.SqlClient,
  automationId: string,
  name: string
): Effect.fn.Return<void, SqlError> {
  yield* sql`UPDATE scheduled_tasks SET name = ${name} WHERE task_id = ${automationId} AND name IS NOT ${name}`
  yield* sql`UPDATE sessions SET name = ${name}
    WHERE origin_automation_id = ${automationId} AND name IS NOT ${name}
      AND session_id = (SELECT thread_id FROM scheduled_tasks WHERE task_id = ${automationId})`
})
