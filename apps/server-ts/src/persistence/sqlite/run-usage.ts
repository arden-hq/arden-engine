import type { RunTerminalResult } from "@arden-hq/protocol/runs"
import { RunUsageSchema } from "@arden-hq/protocol/effect/runs"
import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { ChatWriteError } from "../chat/store.js"
import { decodeJson } from "./json.js"

type Usage = RunTerminalResult["usage"]
const empty: Usage = { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_write: 0 }

/**
 * A source's reported cost: dollars, `unknown` once a call it counts reported
 * none, or `absent` when the source has counted nothing yet (no samples, no
 * final result, never accounted). Unknown is sticky: a Run accounted once
 * with an unpriced call stays unknown.
 */
type Cost = number | "unknown" | "absent"

const costOf = (recorded: boolean, usage: Usage): Cost =>
  recorded ? (usage.cost ?? "unknown") : "absent"

const unionCost = (costs: ReadonlyArray<Cost>): Cost => {
  if (costs.includes("unknown")) return "unknown"
  const known = costs.filter((cost): cost is number => typeof cost === "number")
  return known.length === 0 ? "absent" : Math.max(...known)
}

/** The samples' cost: their sum when every one has a cost, else unknown. */
const samplesCost = (
  sampled:
    | { readonly calls: number; readonly priced: number; readonly spent: number | null }
    | undefined
): Cost => {
  if (sampled === undefined || sampled.calls === 0) return "absent"
  return sampled.priced === sampled.calls ? (sampled.spent ?? 0) : "unknown"
}

const union = (left: Usage, right: Usage): Usage => {
  const prompt = Math.max(left.prompt, right.prompt)
  const completion = Math.max(left.completion, right.completion)
  const cache_read = Math.max(left.cache_read, right.cache_read)
  const cache_write = Math.max(left.cache_write, right.cache_write)
  return {
    prompt,
    completion,
    cache_read,
    cache_write,
    total: prompt + completion + cache_read + cache_write
  }
}

/**
 * A day's cost after adding one more contribution: unknown (NULL) as soon as
 * either side is, as `addCost` sums in the loop.
 */
export const DAILY_COST_SUM = `cost = CASE
        WHEN usage_daily.cost IS NULL OR excluded.cost IS NULL THEN NULL
        ELSE usage_daily.cost + excluded.cost
      END`

const account = Effect.fn("RunUsage.account")(function* (sql: SqlClient.SqlClient, runId: string) {
  const rows = yield* sql<{ readonly accounted: string | null; readonly final: string | null }>`
    SELECT json_extract(metadata_json, '$.accounted_usage') AS accounted,
      json_extract(metadata_json, '$.terminal_result.usage') AS final
    FROM chat_runs WHERE run_id = ${runId}`
  const row = rows[0]
  if (!row)
    return yield* new ChatWriteError({
      operation: "checkpoint",
      reason: "not_found",
      message: "Usage Run not found",
      runId
    })
  const previous = row.accounted === null ? empty : yield* decodeJson(RunUsageSchema, row.accounted)
  const final = row.final === null ? empty : yield* decodeJson(RunUsageSchema, row.final)
  const samples = yield* sql<
    Usage & { readonly calls: number; readonly priced: number; readonly spent: number | null }
  >`SELECT
      coalesce(sum(json_extract(usage_json, '$.prompt')), 0) AS prompt,
      coalesce(sum(json_extract(usage_json, '$.completion')), 0) AS completion,
      coalesce(sum(json_extract(usage_json, '$.cache_read')), 0) AS cache_read,
      coalesce(sum(json_extract(usage_json, '$.cache_write')), 0) AS cache_write,
      coalesce(sum(json_extract(usage_json, '$.total')), 0) AS total,
      count(usage_json) AS calls,
      count(json_extract(usage_json, '$.cost')) AS priced,
      sum(json_extract(usage_json, '$.cost')) AS spent
    FROM run_model_usage WHERE run_id = ${runId}`
  const sampled = samples[0]
  const cost = unionCost([
    costOf(row.accounted !== null, previous),
    samplesCost(sampled),
    costOf(row.final !== null, final)
  ])
  const tokens = union(previous, union(sampled ?? empty, final))
  const current: Usage = typeof cost === "number" ? { ...tokens, cost } : tokens
  const previousCost = typeof previous.cost === "number" ? previous.cost : 0
  yield* sql`INSERT INTO usage_daily (
      day, space_id, origin, session_type, model_id, kind,
      total_tokens, output_tokens, cache_read_tokens, cache_write_tokens, runs, cost
    )
    SELECT date(r.started_at), coalesce(s.space_id, ''),
      CASE WHEN s.origin_automation_id IS NOT NULL
        OR json_extract(r.metadata_json, '$.automation') IS NOT NULL THEN 'automation' ELSE 'user' END,
      s.session_type, coalesce(r.model_id, ''), 'chat',
      ${current.total - previous.total}, ${current.completion - previous.completion},
      ${current.cache_read - previous.cache_read}, ${current.cache_write - previous.cache_write}, ${row.accounted === null ? 1 : 0},
      ${typeof cost === "number" ? cost - previousCost : null}
    FROM chat_runs r JOIN sessions s ON s.session_id = r.session_id WHERE r.run_id = ${runId}
    ON CONFLICT (day, space_id, origin, session_type, model_id, kind) DO UPDATE SET
      total_tokens = total_tokens + excluded.total_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      runs = runs + excluded.runs,
      ${sql.literal(DAILY_COST_SUM)}`
  yield* sql`UPDATE chat_runs SET metadata_json = json_set(metadata_json, '$.accounted_usage', json(${JSON.stringify(current)}))
    WHERE run_id = ${runId}`
  yield* sql`UPDATE execution_budgets SET tokens_used = tokens_used + ${current.total - previous.total}
    WHERE budget_id = (SELECT json_extract(metadata_json, '$.run_policy.budget_id') FROM chat_runs WHERE run_id = ${runId})`
})

export const recordModelRunUsage = Effect.fn("RunUsage.recordResponse")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly runId: string; readonly sampleId: string; readonly usage: Usage }
) {
  const encoded = JSON.stringify(input.usage)
  const rows = yield* sql<{
    readonly usage_json: string | null
  }>`SELECT usage_json FROM run_model_usage
    WHERE run_id = ${input.runId} AND sample_id = ${input.sampleId}`
  if (rows[0]?.usage_json != null) {
    if (rows[0].usage_json === encoded) return
    return yield* new ChatWriteError({
      operation: "checkpoint",
      reason: "invalid",
      message: "A usage receipt cannot change",
      runId: input.runId
    })
  }
  const respondedAt = DateTime.formatIso(yield* DateTime.now)
  yield* sql`INSERT INTO run_model_usage (run_id, sample_id, usage_json, responded_at)
    VALUES (${input.runId}, ${input.sampleId}, ${encoded}, ${respondedAt})
    ON CONFLICT (run_id, sample_id) DO UPDATE SET
      usage_json = excluded.usage_json, responded_at = excluded.responded_at
      WHERE run_model_usage.usage_json IS NULL`
  yield* account(sql, input.runId)
})

export const recordFinalRunUsage = (sql: SqlClient.SqlClient, runId: string) => account(sql, runId)
