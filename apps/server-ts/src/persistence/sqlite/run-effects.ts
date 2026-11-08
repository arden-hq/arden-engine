import type { SqlClient, Statement } from "effect/unstable/sql"
import { CALL_CHANGE_SQL } from "../schema/run-change.js"

export const callChange = (sql: SqlClient.SqlClient): Statement.Fragment =>
  sql.literal(CALL_CHANGE_SQL)

export const runChanged = (
  sql: SqlClient.SqlClient,
  runId: Statement.Fragment | string
): Statement.Fragment =>
  sql`EXISTS (SELECT 1 FROM tool_calls AS call
    WHERE call.run_id = ${runId} AND ${callChange(sql)} != 'none')`
