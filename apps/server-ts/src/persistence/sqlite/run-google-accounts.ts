import type { GoogleServiceId } from "@arden-hq/protocol/google"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { RunPolicySchema } from "../../execution/policy.js"
import { RunQueryError } from "../runs/queries.js"
import { decodeJson } from "./json.js"
import { runMayActSql } from "./run-liveness.js"

export const runGoogleAccounts = Effect.fn("RunQueries.googleAccounts")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  service: GoogleServiceId
): Effect.fn.Return<ReadonlyArray<string> | null, RunQueryError> {
  return yield* Effect.gen(function* () {
    const rows = yield* sql<{ readonly policy: string | null }>`
      SELECT json_extract(run.metadata_json, '$.run_policy') AS policy FROM chat_runs AS run
      WHERE run.run_id = ${runId} AND ${runMayActSql(sql, "run")}
    `
    if (!rows[0]?.policy) return []
    const policy = yield* decodeJson(RunPolicySchema, rows[0].policy)
    if (policy.google_accounts === null) return null
    return policy.google_accounts
      .filter((grant) => grant.service === service)
      .map((grant) => grant.account_id)
  }).pipe(
    Effect.mapError(
      (cause) =>
        new RunQueryError({
          operation: "google_accounts",
          message: "Could not validate Run account access",
          cause
        })
    )
  )
})
