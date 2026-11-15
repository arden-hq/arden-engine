import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"

/** Renames every chat of a job's own that still carries the job's name, open or archived, before
 *  the job takes `name`; a name the owner gave a chat stays. Every writer of a job's name calls
 *  it first. */
export const chatsFollowJobName = Effect.fn("JobLabels.chatsFollow")(function* (
  sql: SqlClient.SqlClient,
  automationId: string,
  name: string
): Effect.fn.Return<void, SqlError> {
  yield* sql`UPDATE sessions SET name = ${name}
    WHERE origin_automation_id = ${automationId} AND session_type = 'channel'
      AND name IS NOT ${name}
      AND name IS (SELECT name FROM scheduled_tasks WHERE task_id = ${automationId})`
})

/** Renames a job, and its chats that carry its name. */
export const renameOwnedJob = Effect.fn("JobLabels.rename")(function* (
  sql: SqlClient.SqlClient,
  automationId: string,
  name: string
): Effect.fn.Return<void, SqlError> {
  yield* chatsFollowJobName(sql, automationId, name)
  yield* sql`UPDATE scheduled_tasks SET name = ${name} WHERE task_id = ${automationId} AND name IS NOT ${name}`
})
