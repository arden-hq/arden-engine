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
    const rows = yield* sql`SELECT 1 FROM space_task_revisions WHERE item_id = ${itemId}
    AND item_id || ':' || version = ${revision}
    AND version = (SELECT MAX(version) FROM space_task_revisions WHERE item_id = ${itemId})`
    if (rows.length === 0)
      return yield* workError(
        "conflict",
        "Task evidence changed or has no baseline; read the Task's history_revision again"
      )
  }
)
