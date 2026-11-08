import { journalRunIdSql } from "./journal-run-boundary.js"
import type { ScriptExecution } from "@arden-hq/protocol/workflows"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill } from "./backfills/backfill.js"

import { ScriptJournalError, type ScriptOrigin } from "../scripts/journal.js"
import { decodeJson } from "./json.js"

const ProgressSchema = Schema.Struct({
  kind: Schema.Literals(["code_mode", "dynamic_workflow"]),
  attempt: Schema.optionalKey(Schema.Int),
  detached: Schema.optionalKey(Schema.Struct({ attempt: Schema.Int })),
  phases: Schema.optionalKey(Schema.Array(Schema.String)),
  phase_entries: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
  agents: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
  tools: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Json)))
})

const executions = (
  records: ReadonlyArray<typeof ProgressSchema.Type>
): ReadonlyArray<ScriptExecution> => {
  const attempts = new Map<number, ScriptExecution>()
  for (const record of records) {
    const attempt = record.detached?.attempt ?? record.attempt ?? 1
    if (attempt < 1) continue
    const previous = attempts.get(attempt)?.data
    attempts.set(attempt, {
      attempt,
      data: {
        kind: "code_mode",
        phases: record.phases?.length ? record.phases : (previous?.["phases"] ?? []),
        phase_entries: record.phase_entries?.length
          ? record.phase_entries
          : (previous?.["phase_entries"] ?? []),
        agents: record.agents?.length ? record.agents : (previous?.["agents"] ?? []),
        tools: record.tools?.length ? record.tools : (previous?.["tools"] ?? [])
      }
    })
  }
  return [...attempts.values()].sort((a, b) => a.attempt - b.attempt)
}

export const readScriptExecutions = Effect.fn("ScriptJournal.executions")(function* (
  sql: SqlClient.SqlClient,
  origin: ScriptOrigin
) {
  const saved = yield* sql<{
    readonly progress_json: string | null
  }>`SELECT progress_json FROM code_mode_scripts
    WHERE origin_run_id = ${origin.originRunId} AND origin_tool_call_id = ${origin.originToolCallId}`.pipe(
    Effect.mapError(
      (cause) => new ScriptJournalError({ message: "Could not read script progress", cause })
    )
  )
  const data = saved[0]?.progress_json
  if (data !== undefined && data !== null) {
    const decoded = yield* decodeJson(
      Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
      data
    ).pipe(
      Effect.mapError(
        (cause) => new ScriptJournalError({ message: "Stored script progress is corrupt", cause })
      )
    )
    return Object.entries(decoded)
      .map(([attempt, value]) => ({ attempt: Number(attempt), data: value }))
      .filter((entry) => Number.isSafeInteger(entry.attempt) && entry.attempt > 0)
      .sort((a, b) => a.attempt - b.attempt)
  }
  const rows = yield* sql<{ readonly data: string }>`
    SELECT json_extract(result_json, '$.data') AS data FROM tool_calls
    WHERE run_id = ${origin.originRunId} AND tool_call_id = ${origin.originToolCallId}
    UNION ALL
    SELECT json_extract(data_json, '$.data') AS data FROM (
      SELECT data_json FROM journal_records
      WHERE stream_id = (SELECT session_id FROM chat_runs WHERE run_id = ${origin.originRunId})
        AND event_type = 'TOOL_CALL_PROGRESS'
        AND json_extract(data_json, '$.tool_call_id') = ${origin.originToolCallId}
        AND ${journalRunIdSql(sql)} = ${origin.originRunId}
      ORDER BY sequence
    )
  `.pipe(
    Effect.mapError(
      (cause) => new ScriptJournalError({ message: "Could not read script progress", cause })
    )
  )
  const decoded = yield* Effect.forEach(rows, (row) =>
    decodeJson(ProgressSchema, row.data).pipe(Effect.option)
  )
  return executions(decoded.flatMap((row) => (Option.isSome(row) ? [row.value] : [])))
})

export const scriptProgressBackfill: Backfill = {
  name: "script_execution_progress",
  chunk: Effect.fn("ScriptProgress.backfill")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly script_ref: string
      readonly origin_run_id: string
      readonly origin_tool_call_id: string
    }>`
      SELECT script_ref, origin_run_id, origin_tool_call_id FROM code_mode_scripts
      WHERE script_ref > ${cursor ?? ""} AND progress_json IS NULL ORDER BY script_ref LIMIT ${Math.min(limit, 1)}`
    let converted = 0
    for (const row of rows) {
      const result = yield* readScriptExecutions(sql, {
        originRunId: row.origin_run_id,
        originToolCallId: row.origin_tool_call_id
      }).pipe(Effect.option)
      if (Option.isNone(result)) continue
      const value = Object.fromEntries(
        result.value.map((entry) => [String(entry.attempt), entry.data])
      )
      yield* sql`UPDATE code_mode_scripts SET progress_json = ${JSON.stringify(value)} WHERE script_ref = ${row.script_ref} AND progress_json IS NULL`
      converted += 1
    }
    return { converted, next: rows.at(-1)?.script_ref }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly count: number
    }>`SELECT COUNT(*) AS count FROM code_mode_scripts WHERE progress_json IS NULL`
    return rows[0]?.count ?? 0
  })
}
