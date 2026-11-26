import type { SqlClient, Statement } from "effect/unstable/sql"
import type { Row } from "effect/unstable/sql/SqlConnection"

/** "Is this Automation running" has two meanings, and each is read only here.
 *
 * A run is open from its claim until it ends: through a retry wait, a deferral
 * and its chat run after the job is released. That is what a person and the
 * model are told, and what refuses a delete or a second run by hand.
 *
 * A worker holds one of its jobs only from a claim to that job's settlement,
 * release, retry or deferral (`job_held_since`, written by the claim and by
 * settlement). Only the queue asks this, to give one job of an Automation to
 * one worker at a time. */

/** When the Automation's open run started, or NULL when none is open. */
export const openRunSince = (
  sql: SqlClient.SqlClient,
  automationId: Statement.Fragment
): Statement.Statement<Row> =>
  sql`(SELECT MIN(open_run.started_at) FROM automation_runs AS open_run
    WHERE open_run.status = 'running' AND open_run.task_id = ${automationId})`

/** Since when a worker holds one of its jobs, or NULL; `task` names the
 * `scheduled_tasks` row in the query. */
export const jobHeldSince = (sql: SqlClient.SqlClient, task: string): Statement.Statement<Row> =>
  sql`${sql.literal(task)}.job_held_since`
