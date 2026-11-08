import type { SqlClient } from "effect/unstable/sql"

export const dropPendingArchive = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql`DELETE FROM session_pending_archives WHERE session_id = ${sessionId}`
