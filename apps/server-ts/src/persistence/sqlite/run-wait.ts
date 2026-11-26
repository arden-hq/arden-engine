import type { SqlClient, Statement } from "effect/unstable/sql"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const awaitingApproval = (
  sql: SqlClient.SqlClient,
  runId: Statement.Fragment
): Statement.Statement<Row> =>
  sql`EXISTS (SELECT 1 FROM tool_approvals AS approval
    WHERE approval.run_id = ${runId} AND approval.status = 'pending')`

export const quotaPauseUntil = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment
): Statement.Statement<Row> => sql`json_extract(${metadata}, '$.quota_pause.until')`

export const quotaPaused = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment,
  now: string
): Statement.Statement<Row> => sql`(${quotaPauseUntil(sql, metadata)} IS NOT NULL
  AND ${quotaPauseUntil(sql, metadata)} > ${now})`

export const parkedOnQuota = (
  sql: SqlClient.SqlClient,
  status: Statement.Fragment,
  metadata: Statement.Fragment
): Statement.Statement<Row> =>
  sql`(${status} = 'pending' AND ${quotaPauseUntil(sql, metadata)} IS NOT NULL)`
