import { RunMemoryContextSchema } from "@arden-hq/protocol/effect/runs"
import type { RunMemoryContext } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"

// `run_sidecars.context_manifest_json` holds what a run was sent from Memory: every composition
// of its Memory context, in order, in the shape of `RunMemoryContextSchema`. `'[]'` (the column
// default) is "sent none". It is kept as long as the run is.
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
      readonly context: RunMemoryContext
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
