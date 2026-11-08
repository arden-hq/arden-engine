import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { WorkStoreError } from "../work/store.js"
import { actsAsPersonSql } from "./authority-sql.js"
import { runMayActSql } from "./run-liveness.js"

const failure = (message: string, cause?: unknown) =>
  new WorkStoreError({ reason: "conflict", message, ...(cause === undefined ? {} : { cause }) })

export const assertPersonRun = Effect.fn("RunPolicy.assertPerson")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql`SELECT 1 FROM chat_runs AS run
    WHERE run.run_id = ${runId} AND ${runMayActSql(sql, "run")}
      AND ${actsAsPersonSql(sql, sql`run.authority_json`)}`.pipe(
    Effect.mapError((cause) => failure("Could not inspect Chat control authority", cause))
  )
  if (rows.length === 0)
    return yield* failure(
      "This control requires the person's own Chat, still running or with work still running; workers cannot change their own standing authority"
    )
})
