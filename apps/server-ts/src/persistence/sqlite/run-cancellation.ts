import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { closeRunAsks } from "./run-asks.js"
import { appendRunsFencedInTransaction } from "./run-fenced.js"
import { runDescendants } from "./tree-walk.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"

export const runCancellationRequested = (sql: SqlClient.SqlClient, metadata: Statement.Fragment) =>
  sql`json_extract(${metadata}, '$.cancelled_by_run_id') IS NOT NULL`

export const fenceRunCancellation = Effect.fn("RunCancellation.fence")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly runId: string
  readonly now: string
}) {
  const { sql, runId, now } = options
  const roots = yield* sql<{
    readonly mode: string | null
  }>`SELECT json_extract(metadata_json, '$.run_policy.execution.mode') AS mode
    FROM chat_runs WHERE run_id = ${runId}`
  const cascade = roots[0]?.mode === "worker"
  const tree = sql`WITH RECURSIVE ${runDescendants(sql, {
    name: "cancelled_branch",
    from: sql`SELECT ${runId} AS run_id`,
    where: sql`${cascade ? 1 : 0} = 1`
  })}`
  const affected = yield* sql<{
    readonly run_id: string
    readonly session_id: string
    readonly status: string
  }>`
    ${tree}
    UPDATE chat_runs SET metadata_json = json_set(metadata_json, '$.cancelled_by_run_id',
      COALESCE(json_extract(metadata_json, '$.cancelled_by_run_id'), ${runId}))
    WHERE run_id = ${runId}
      OR (${cascade ? 1 : 0} = 1 AND run_id IN (SELECT run_id FROM cancelled_branch))
    RETURNING run_id, session_id, status`
  yield* appendRunsFencedInTransaction(sql, options.sessionEvents, affected)
  yield* closeRunAsks({
    sql,
    runs: sql`${tree} SELECT run_id FROM cancelled_branch`,
    now
  })
  return {
    activeRunIds: affected.filter((run) => isActiveRunStatus(run.status)).map((run) => run.run_id)
  }
})
