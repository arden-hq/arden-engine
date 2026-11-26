import type { SqlClient } from "effect/unstable/sql"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const dropPendingArchive = (sql: SqlClient.SqlClient, sessionId: string): Statement<Row> =>
  sql`DELETE FROM session_pending_archives WHERE session_id = ${sessionId}`
