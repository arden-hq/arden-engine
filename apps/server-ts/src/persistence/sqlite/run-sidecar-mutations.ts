import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

interface RunSidecarIdentity {
  readonly runId: string
  readonly sessionId: string
}

export const recordBlockedAutomationInTransaction = Effect.fn(
  "RunSidecars.recordBlockedAutomation"
)(function* (
  sql: SqlClient.SqlClient,
  input: RunSidecarIdentity & {
    readonly kind: string
    readonly reason: string
    readonly updatedAt: string
  }
) {
  const outcome = JSON.stringify({ status: "blocked", kind: input.kind, reason: input.reason })
  yield* sql`
      INSERT INTO run_sidecars (
        run_id, session_id, context_manifest_json, source_refs_json,
        evidence_json, updated_at
      ) VALUES (
        ${input.runId}, ${input.sessionId}, '[]', '[]',
        json_object('automation_outcome', json(${outcome})), ${input.updatedAt}
      )
      ON CONFLICT(run_id) DO UPDATE SET
        evidence_json = json_set(
          run_sidecars.evidence_json,
          '$.automation_outcome',
          json(${outcome})
        ),
        updated_at = excluded.updated_at
    `
})

export const deleteRunSidecarsBySessionInTransaction = Effect.fn("RunSidecars.deleteBySession")(
  function* (sql: SqlClient.SqlClient, sessionId: string) {
    yield* sql`DELETE FROM run_sidecars WHERE session_id = ${sessionId}`
  }
)
