import { RunMemoryContextSchema } from "@arden-hq/protocol/effect/runs"
import type { RunMemoryComposition } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
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

// `run_sidecars.context_manifest_json` holds every composition of the run's Memory context, in
// order. `'[]'` (the column default) means none was sent.
const MemoryContextJson = Schema.fromJsonString(Schema.Array(RunMemoryContextSchema))
const CompositionJson = Schema.fromJsonString(RunMemoryContextSchema)
const decodeRecord = Schema.decodeUnknownEffect(MemoryContextJson)

/** What the run was sent from Memory, in order; empty when it was sent none or ran before records. */
export const readMemoryContext = Effect.fn("RunSidecars.readMemoryContext")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{ readonly context_manifest_json: string }>`
    SELECT context_manifest_json FROM run_sidecars WHERE run_id = ${runId}`
  const row = rows[0]
  if (row === undefined) return []
  return yield* decodeRecord(row.context_manifest_json)
})

/**
 * Adds a composition to the run's record. A rebuilt context that repeats the last composition
 * adds nothing, and a run whose first composition holds nothing adds no row.
 */
export const recordMemoryContextInTransaction = Effect.fn("RunSidecars.recordMemoryContext")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly runId: string
      readonly sessionId: string
      readonly context: RunMemoryComposition
    }
  ) {
    const record = yield* readMemoryContext(sql, input.runId)
    const last = record.at(-1)
    if (last === undefined && input.context.sources.length === 0) return
    const encode = Schema.encodeEffect(CompositionJson)
    if (last !== undefined && (yield* encode(last)) === (yield* encode(input.context))) return
    const encoded = yield* Schema.encodeEffect(MemoryContextJson)([...record, input.context])
    const updatedAt = DateTime.formatIso(yield* DateTime.now)
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
