import { Effect, Schema } from "effect"
import type { SqlClient, SqlError, Statement } from "effect/unstable/sql"
import { runAuthorityState } from "./run-context.js"
import { runColumns } from "./run-destination.js"
import { runPolicyRevoked } from "./run-policy.js"
import { RUN_LIVENESS, runMayAct, type RunLiveness } from "../runs/liveness.js"
import { activeRunStatusList, openDeferredCallStatusList } from "./status-sets.js"

const [TURN, BACKGROUND, ENDED, REVOKED] = RUN_LIVENESS
const ACTING = RUN_LIVENESS.filter(runMayAct)

export const runOwnsLiveWork = (sql: SqlClient.SqlClient, runId: Statement.Fragment) => sql`(
  EXISTS (SELECT 1 FROM code_mode_scripts AS script
    WHERE script.origin_run_id = ${runId} AND script.status = 'running')
  OR EXISTS (SELECT 1 FROM deferred_tool_calls AS card
    WHERE card.run_id = ${runId} AND card.status IN ${openDeferredCallStatusList}))`

export const runHoldsWorkSql = (sql: SqlClient.SqlClient, alias: string): Statement.Fragment => {
  const run = runColumns(sql, alias)
  return sql`(${run.status} IN ${activeRunStatusList} OR ${runOwnsLiveWork(sql, run.runId)})`
}

const runLivenessSql = (sql: SqlClient.SqlClient, alias: string): Statement.Fragment => {
  const run = runColumns(sql, alias)
  return sql`(CASE
    WHEN ${runAuthorityState(sql, run.metadata, run.runId)} != 'active'
      OR ${runPolicyRevoked(sql, run.metadata, false)} THEN ${REVOKED}
    WHEN ${run.status} IN ${activeRunStatusList} THEN ${TURN}
    WHEN ${runOwnsLiveWork(sql, run.runId)} THEN ${BACKGROUND}
    ELSE ${ENDED}
  END)`
}

export const runMayActSql = (sql: SqlClient.SqlClient, alias: string): Statement.Fragment =>
  sql`(${runLivenessSql(sql, alias)} IN ${sql.in(ACTING)})`

export const readRunLiveness = Effect.fn("RunLiveness.read")(function* (
  sql: SqlClient.SqlClient,
  runId: string
): Effect.fn.Return<RunLiveness | undefined, SqlError.SqlError | Schema.SchemaError> {
  const rows = yield* sql<{ readonly liveness: unknown }>`
    SELECT ${runLivenessSql(sql, "run")} AS liveness FROM chat_runs AS run
    WHERE run.run_id = ${runId}`
  if (rows[0] === undefined) return undefined
  return yield* Schema.decodeUnknownEffect(Schema.Literals(RUN_LIVENESS))(rows[0].liveness)
})
