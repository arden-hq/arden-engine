import type { SqlClient, Statement } from "effect/unstable/sql"

export const awaitingApproval = (sql: SqlClient.SqlClient, runId: Statement.Fragment) =>
  sql`EXISTS (SELECT 1 FROM tool_approvals AS approval
    WHERE approval.run_id = ${runId} AND approval.status = 'pending')`

export const quotaPauseUntil = (sql: SqlClient.SqlClient, metadata: Statement.Fragment) =>
  sql`json_extract(${metadata}, '$.quota_pause.until')`

export const quotaPaused = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment,
  now: string
) => sql`(${quotaPauseUntil(sql, metadata)} IS NOT NULL
  AND ${quotaPauseUntil(sql, metadata)} > ${now})`

export const parkedOnQuota = (
  sql: SqlClient.SqlClient,
  status: Statement.Fragment,
  metadata: Statement.Fragment
) => sql`(${status} = 'pending' AND ${quotaPauseUntil(sql, metadata)} IS NOT NULL)`
