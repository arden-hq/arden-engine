import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { workError } from "./work-records.js"

export const taskRevisionRef = (
  sql: SqlClient.SqlClient,
  itemId: Statement.Fragment,
  version: Statement.Fragment
): Statement.Fragment =>
  sql`CASE WHEN ${version} IS NULL THEN NULL ELSE ${itemId} || ':' || ${version} END`

export const assertCurrentTaskRevision = Effect.fn("WorkHistory.assertCurrentTaskRevision")(
  function* (sql: SqlClient.SqlClient, itemId: string, revision: string | null) {
    const rows = yield* sql`SELECT 1 FROM space_tasks AS task WHERE task.item_id = ${itemId}
    AND task.item_id || ':' || COALESCE(
      (SELECT MAX(version) FROM space_task_revisions WHERE item_id = task.item_id), 0
    ) = ${revision}`
    if (rows.length === 0)
      return yield* workError("conflict", "Task evidence changed; read the Task again")
  }
)
