import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { causedChainDepth } from "../automations/chain-depth.js"
import type { RunCause } from "../runs/queries.js"
import { SessionLifecycleEventError } from "../sessions/events.js"

const delegationRoot = (run: string): string =>
  `FROM chat_runs AS root
    WHERE root.run_id = COALESCE(json_extract(${run}.authority_json, '$.delegation.chain[0]'), ${run}.run_id)`

export const causingAutomation = (
  sql: SqlClient.SqlClient,
  run: string
): ReturnType<SqlClient.SqlClient["literal"]> =>
  sql.literal(`COALESCE(
      json_extract(${run}.authority_json, '$.owns.automation_id'),
      (SELECT COALESCE(
          json_extract(root.authority_json, '$.owns.automation_id'),
          json_extract(root.metadata_json, '$.run_context.origin.automation_id'))
        ${delegationRoot(run)})
    )`)

export const causingWakeDepth = (
  sql: SqlClient.SqlClient,
  run: string
): ReturnType<SqlClient.SqlClient["literal"]> =>
  sql.literal(`MAX(
      COALESCE(json_extract(${run}.authority_json, '$.owns.chain_depth'), 0),
      COALESCE((SELECT MAX(
          COALESCE(json_extract(root.authority_json, '$.owns.chain_depth'), 0),
          COALESCE(json_extract(root.metadata_json, '$.run_context.origin.chain_depth'), 0))
        ${delegationRoot(run)}), 0)
    )`)

export const readCause = (sql: SqlClient.SqlClient, runId: string) =>
  sql<{
    readonly automation_id: string | null
    readonly chain_depth: number
  }>`
    SELECT ${causingAutomation(sql, "run")} AS automation_id,
      ${causingWakeDepth(sql, "run")} AS chain_depth
    FROM chat_runs AS run
    WHERE run.run_id = ${runId}
  `.pipe(
    Effect.map(([row]): RunCause => ({
      automationId: row?.automation_id ?? undefined,
      wakeDepth: row?.chain_depth ?? 0
    }))
  )

export const readRunCause = Effect.fn("SessionLifecycleEvents.readRunCause")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const cause = yield* readCause(sql, runId).pipe(
    Effect.mapError(
      (failure) =>
        new SessionLifecycleEventError({
          operation: "append",
          message: "Could not read what caused the run",
          cause: failure
        })
    )
  )
  const producedBy = cause.automationId ?? null
  return {
    produced_by: producedBy,
    chain_depth: causedChainDepth(producedBy, cause.wakeDepth)
  }
})
