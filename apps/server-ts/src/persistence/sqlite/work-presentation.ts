import type { SqlClient } from "effect/unstable/sql"

const TASK_NOTICE_EVENT_TYPES = ["done", "reported"] as const

export const taskEventSpeaksSql = (sql: SqlClient.SqlClient) =>
  sql`(event.event_type IN ${sql.in(TASK_NOTICE_EVENT_TYPES)} AND event.run_ref IS NOT NULL)`
