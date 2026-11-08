import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill } from "./backfills/backfill.js"
import { decisionLineageSql } from "../schema/decision-visibility.js"

interface SourceRow {
  readonly rowid: number
  readonly run_id: string
  readonly session_id: string
  readonly tool_call_id: string
  readonly status: string
}

interface LineageRow {
  readonly session_type: string
  readonly edge_valid: number
}

const validLineage = Effect.fn("PendingDecisionVisibility.validLineage")(function* (
  sql: SqlClient.SqlClient,
  sourceSessionId: string
) {
  const rows = yield* sql.unsafe<LineageRow>(decisionLineageSql("?"), [sourceSessionId])
  return (
    rows.length > 0 &&
    rows.some((row) => row.session_type !== "agent") &&
    rows.every((row) => row.edge_valid === 1)
  )
})

const cursorOf = (kind: "run" | "deferred", rowid: number): string =>
  `${kind === "run" ? "r" : "d"}:${rowid}`

export const pendingDecisionVisibilityBackfill: Backfill = {
  name: "pending_decision_visibility_v2",
  chunk: Effect.fn("PendingDecisionVisibility.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const deferred = cursor?.startsWith("d:") === true
    const rowid = cursor === undefined ? 0 : Number(cursor.slice(2))
    if (cursor !== undefined && (!Number.isSafeInteger(rowid) || rowid < 0))
      throw new Error(`Invalid decision visibility cursor ${cursor}`)
    const rows = deferred
      ? yield* sql<SourceRow>`SELECT rowid, run_id, session_id, tool_call_id, status
          FROM deferred_tool_calls WHERE status = 'pending' AND rowid > ${rowid}
          ORDER BY rowid LIMIT ${limit}`
      : yield* sql<SourceRow>`SELECT rowid, run_id, session_id, tool_call_id, status
          FROM tool_approvals WHERE status = 'pending' AND rowid > ${rowid}
          ORDER BY rowid LIMIT ${limit}`
    let converted = 0
    for (const source of rows) {
      if (source.status !== "pending") continue
      const kind = deferred ? "deferred" : "run"
      if (!(yield* validLineage(sql, source.session_id))) {
        yield* sql`INSERT OR IGNORE INTO pending_decision_visibility_unresolved (
          source_kind, run_id, tool_call_id, approval_run_id, approval_tool_call_id,
          deferred_run_id, deferred_tool_call_id)
          VALUES (${kind}, ${source.run_id}, ${source.tool_call_id},
            ${deferred ? null : source.run_id}, ${deferred ? null : source.tool_call_id},
            ${deferred ? source.run_id : null}, ${deferred ? source.tool_call_id : null})`
        continue
      }
      const existing = yield* sql<{ readonly present: number }>`
        SELECT 1 AS present FROM pending_decision_visibility
        WHERE viewer_session_id = ${source.session_id}
          AND source_kind = ${kind} AND run_id = ${source.run_id}
          AND tool_call_id = ${source.tool_call_id} LIMIT 1`
      if (existing.length > 0) continue
      if (deferred) {
        yield* sql`UPDATE deferred_tool_calls SET status = status
          WHERE rowid = ${source.rowid} AND status = 'pending'`
      } else {
        yield* sql`UPDATE tool_approvals SET status = status
          WHERE rowid = ${source.rowid} AND status = 'pending'`
      }
      converted += 1
    }
    const last = rows.at(-1)
    if (last !== undefined)
      return { converted, next: cursorOf(deferred ? "deferred" : "run", last.rowid) }
    if (!deferred) return { converted, next: "d:0" }
    return { converted, next: undefined }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly count: number }>`
      SELECT
        (SELECT COUNT(*) FROM tool_approvals AS source WHERE source.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM pending_decision_visibility AS visibility
            WHERE visibility.viewer_session_id = source.session_id
              AND visibility.source_kind = 'run' AND visibility.run_id = source.run_id
              AND visibility.tool_call_id = source.tool_call_id)
          AND NOT EXISTS (SELECT 1 FROM pending_decision_visibility_unresolved AS unresolved
            WHERE unresolved.source_kind = 'run' AND unresolved.run_id = source.run_id
              AND unresolved.tool_call_id = source.tool_call_id)) +
        (SELECT COUNT(*) FROM deferred_tool_calls AS source WHERE source.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM pending_decision_visibility AS visibility
            WHERE visibility.viewer_session_id = source.session_id
              AND visibility.source_kind = 'deferred' AND visibility.run_id = source.run_id
              AND visibility.tool_call_id = source.tool_call_id)
          AND NOT EXISTS (SELECT 1 FROM pending_decision_visibility_unresolved AS unresolved
            WHERE unresolved.source_kind = 'deferred' AND unresolved.run_id = source.run_id
              AND unresolved.tool_call_id = source.tool_call_id)) AS count`
    return rows[0]?.count ?? 0
  })
}
