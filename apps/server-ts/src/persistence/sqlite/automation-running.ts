import type { SqlClient, Statement } from "effect/unstable/sql"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const openRunSince = (
  sql: SqlClient.SqlClient,
  automationId: Statement.Fragment
): Statement.Statement<Row> =>
  sql`(SELECT MIN(open_run.started_at) FROM automation_runs AS open_run
    WHERE open_run.status = 'running' AND open_run.task_id = ${automationId})`

export const jobHeldSince = (sql: SqlClient.SqlClient, task: string): Statement.Statement<Row> =>
  sql`${sql.literal(task)}.job_held_since`
