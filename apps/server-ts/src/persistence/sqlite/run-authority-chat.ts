import type { SqlClient, Statement } from "effect/unstable/sql"

export const runAuthorityChatSql = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment,
  sessionId: Statement.Fragment
): Statement.Fragment =>
  sql`COALESCE(json_extract(${metadata}, '$.run_policy.authority_session_id'), ${sessionId})`
