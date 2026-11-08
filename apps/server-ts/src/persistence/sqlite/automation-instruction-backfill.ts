import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill } from "./backfills/backfill.js"
import {
  instructionDestination,
  instructionHash,
  instructionPayload,
  matchesInstructionReceipt,
  type InstructionRow
} from "./automation-instruction-provenance.js"
import { userAutomationSql } from "./authority-sql.js"

const NAME = "automation_instruction_provenance"

export const automationInstructionBackfill: Backfill = {
  name: NAME,
  chunk: Effect.fn("AutomationInstruction.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    if (cursor === undefined || cursor.startsWith("calls:")) {
      const after = cursor === undefined ? 0 : Number(cursor.slice(6))
      if (!Number.isSafeInteger(after) || after < 0)
        throw new Error("Invalid Automation receipt cursor")
      const window = yield* sql<{ readonly id: number }>`
        SELECT rowid AS id FROM tool_calls WHERE rowid > ${after}
        ORDER BY rowid LIMIT ${limit}`
      const last = window.at(-1)
      if (last === undefined) return { converted: 0, next: "autos:" }
      const receipts = yield* sql<{
        readonly call_rowid: number
        readonly run_id: string
        readonly tool_call_id: string
        readonly automation_ref: string
      }>`SELECT call.rowid AS call_rowid, call.run_id, call.tool_call_id,
          CASE WHEN json_valid(call.result_json)
            THEN json_extract(call.result_json, '$.data.automation_ref') END AS automation_ref
        FROM tool_calls AS call
        WHERE call.rowid BETWEEN ${window[0]?.id ?? last.id} AND ${last.id}
          AND call.tool_name IN ('automation_create', 'automation_update')
          AND call.status = 'completed'
          AND CASE WHEN json_valid(call.result_json)
            THEN COALESCE(json_extract(call.result_json, '$.is_error'), 0) = 0
              AND json_extract(call.result_json, '$.host.mutation_receipt.outcome') = 'applied'
              AND json_type(call.result_json, '$.data.automation_ref') = 'text'
            ELSE 0 END`
      for (const receipt of receipts) {
        yield* sql`INSERT INTO automation_instruction_candidates (
            automation_ref, call_rowid, source_run_id, source_tool_call_id
          ) SELECT ${receipt.automation_ref}, ${receipt.call_rowid},
              ${receipt.run_id}, ${receipt.tool_call_id}
            WHERE EXISTS (SELECT 1 FROM scheduled_tasks
              WHERE automation_ref = ${receipt.automation_ref} AND ${userAutomationSql()})
          ON CONFLICT(automation_ref) DO UPDATE SET
            call_rowid = excluded.call_rowid,
            source_run_id = excluded.source_run_id,
            source_tool_call_id = excluded.source_tool_call_id
          WHERE excluded.call_rowid > automation_instruction_candidates.call_rowid`
      }
      return {
        converted: receipts.length,
        next: window.length < limit ? "autos:" : `calls:${last.id}`
      }
    }
    if (!cursor.startsWith("autos:")) throw new Error("Invalid Automation revision cursor")
    const after = cursor.slice(6)
    const rows = yield* sql<
      InstructionRow & {
        readonly task_id: string
        readonly automation_ref: string
        readonly created_at: string
      }
    >`SELECT task_id, automation_ref, created_at, name, description, prompt,
        model, context_mode, triggers, thread_id, cooldown_minutes,
        prompt_author, instruction_revision_id
      FROM scheduled_tasks WHERE task_id > ${after} AND ${userAutomationSql()}
      ORDER BY task_id LIMIT ${limit}`
    let converted = 0
    for (const row of rows) {
      if (row.instruction_revision_id !== null) continue
      const payload = yield* Effect.try(() => instructionPayload(row)).pipe(Effect.option)
      if (payload._tag === "None") continue
      const [candidate] = yield* sql<{
        readonly source_run_id: string
        readonly source_tool_call_id: string
        readonly tool_name: string
        readonly status: string
        readonly arguments_json: string
        readonly result_json: string | null
        readonly ended_at: string | null
      }>`SELECT candidate.source_run_id, candidate.source_tool_call_id,
          call.tool_name, call.status, call.arguments_json, call.result_json, call.ended_at
        FROM automation_instruction_candidates AS candidate
        JOIN tool_calls AS call ON call.run_id = candidate.source_run_id
          AND call.tool_call_id = candidate.source_tool_call_id
        WHERE candidate.automation_ref = ${row.automation_ref} LIMIT 1`
      const destination = yield* instructionDestination(sql, row.task_id, row.thread_id)
      const resultJson = candidate?.result_json
      const sourceMatches =
        candidate !== undefined &&
        candidate.status === "completed" &&
        resultJson !== null &&
        resultJson !== undefined &&
        (yield* Effect.try(() =>
          matchesInstructionReceipt({
            result: JSON.parse(resultJson) as unknown,
            args: JSON.parse(candidate.arguments_json) as unknown,
            toolName: candidate.tool_name,
            automationRef: row.automation_ref,
            destination,
            instruction: row
          })
        ).pipe(Effect.orElseSucceed(() => false)))
      const source = sourceMatches ? candidate : undefined
      const [revision] = yield* sql<{ readonly revision_id: number }>`
        INSERT INTO automation_instruction_revisions (
          task_id, instruction_json, instruction_hash,
          prompt_author, source_run_id, source_tool_call_id, written_at
        ) VALUES (
          ${row.task_id}, ${payload.value}, ${instructionHash(payload.value)},
          ${row.prompt_author}, ${source?.source_run_id ?? null},
          ${source?.source_tool_call_id ?? null},
          ${source?.ended_at ?? row.created_at}
        ) RETURNING revision_id`
      if (revision === undefined) throw new Error("Automation backfill revision was not saved")
      yield* sql`UPDATE scheduled_tasks SET instruction_revision_id = ${revision.revision_id}
        WHERE task_id = ${row.task_id} AND instruction_revision_id IS NULL`
      converted += 1
    }
    const last = rows.at(-1)
    return {
      converted,
      next: last === undefined || rows.length < limit ? undefined : `autos:${last.task_id}`
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [state] = yield* sql<{
      readonly cursor: string | null
      readonly finished_at: string | null
    }>`
      SELECT cursor, finished_at FROM data_backfills WHERE name = ${NAME} LIMIT 1`
    if (state?.finished_at !== null && state?.finished_at !== undefined) return 0
    if (state?.cursor?.startsWith("autos:")) {
      const [row] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM scheduled_tasks
        WHERE ${userAutomationSql()} AND instruction_revision_id IS NULL`
      return row?.n ?? 0
    }
    const after = state?.cursor?.startsWith("calls:") ? Number(state.cursor.slice(6)) : 0
    const [row] = yield* sql<{ readonly n: number }>`SELECT max(0,
      COALESCE((SELECT max(rowid) FROM tool_calls), 0) - ${after}) AS n`
    return row?.n ?? 0
  })
}
