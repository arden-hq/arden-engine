import type { SqlClient } from "effect/unstable/sql"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

const TASK_NOTICE_EVENT_TYPES = ["done", "reported"] as const

export const taskEventSpeaksSql = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`(event.event_type IN ${sql.in(TASK_NOTICE_EVENT_TYPES)} AND event.run_ref IS NOT NULL)`
