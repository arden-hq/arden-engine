import { RunMemorySourceSchema } from "@arden-hq/protocol/effect/runs"
import type { RunMemorySource } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"

// `run_sidecars.context_manifest_json` holds what a run was sent from Memory, in the shape of
// `RunMemorySourceSchema`; `'[]'` (the column default) is "sent none". It is kept as long as
// the run is.
const MemoryContextJson = Schema.fromJsonString(Schema.Array(RunMemorySourceSchema))

/**
 * Stores the latest Memory record of a run. An empty record only clears an earlier one, so a
 * run sent no Memory adds no row.
 */
export const recordMemoryContextInTransaction = Effect.fn("RunSidecars.recordMemoryContext")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly runId: string
      readonly sessionId: string
      readonly sources: ReadonlyArray<RunMemorySource>
    }
  ) {
    const encoded = yield* Schema.encodeEffect(MemoryContextJson)(input.sources)
    const updatedAt = DateTime.formatIso(yield* DateTime.now)
    if (input.sources.length === 0) {
      yield* sql`UPDATE run_sidecars SET context_manifest_json = '[]', updated_at = ${updatedAt}
        WHERE run_id = ${input.runId} AND context_manifest_json <> '[]'`
      return
    }
    yield* sql`
      INSERT INTO run_sidecars (
        run_id, session_id, context_manifest_json, source_refs_json, evidence_json, updated_at
      ) VALUES (${input.runId}, ${input.sessionId}, ${encoded}, '[]', '{}', ${updatedAt})
      ON CONFLICT(run_id) DO UPDATE SET
        context_manifest_json = excluded.context_manifest_json,
        updated_at = excluded.updated_at
    `
  }
)

/** What the run was sent from Memory; empty when it was sent none or ran before records. */
export const readMemoryContext = Effect.fn("RunSidecars.readMemoryContext")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{ readonly context_manifest_json: string }>`
    SELECT context_manifest_json FROM run_sidecars WHERE run_id = ${runId}`
  const row = rows[0]
  return row === undefined
    ? []
    : yield* Schema.decodeUnknownEffect(MemoryContextJson)(row.context_manifest_json)
})
