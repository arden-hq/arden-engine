import { DateTime, Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { WorkStoreError } from "../work/store.js"
import { runCancellationRequested } from "./run-cancellation.js"
import { modelTurnRunStatusList } from "./status-sets.js"

const failure = (message: string) => new WorkStoreError({ reason: "conflict", message })

export const createExecutionBudget = Effect.fn("ExecutionBudget.create")(function* (
  sql: SqlClient.SqlClient,
  budgetId: string
) {
  yield* sql`INSERT INTO execution_budgets (budget_id) VALUES (${budgetId})`
  return budgetId
})

export const executionBudgetExpired = (
  sql: SqlClient.SqlClient,
  metadata: Statement.Fragment
) => sql`(
  ${runCancellationRequested(sql, metadata)} OR NOT EXISTS (
  SELECT 1 FROM execution_budgets AS budget
  WHERE budget.budget_id = json_extract(${metadata}, '$.run_policy.budget_id')
    AND (budget.token_limit IS NULL OR budget.tokens_used < budget.token_limit)
))`

export const readBudgetRemaining = Effect.fn("ExecutionBudget.remaining")(function* (
  sql: SqlClient.SqlClient,
  budgetId: string
) {
  const rows = yield* sql<{
    readonly token_limit: number | null
    readonly tokens_used: number
  }>`SELECT token_limit, tokens_used FROM execution_budgets WHERE budget_id = ${budgetId}`
  const row = rows[0]
  if (!row) return yield* failure("This Run's token budget is missing")
  if (row.token_limit !== null && row.tokens_used >= row.token_limit)
    return yield* failure("The shared token allowance has been spent")
  return { remainingTokens: row.token_limit === null ? null : row.token_limit - row.tokens_used }
})

export const readExecutionBudget = Effect.fn("ExecutionBudget.read")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{ readonly budget_id: string | null; readonly stopped: number }>`
    SELECT json_extract(metadata_json, '$.run_policy.budget_id') AS budget_id,
      ${runCancellationRequested(sql, sql`metadata_json`)} AS stopped
    FROM chat_runs WHERE run_id = ${runId}`
  const row = rows[0]
  if (row?.budget_id == null) return yield* failure("This Run's token budget is missing")
  if (row.stopped) return yield* failure("This Run was stopped")
  return yield* readBudgetRemaining(sql, row.budget_id)
})

export const admitModelRequest = Effect.fn("ExecutionBudget.admitModel")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  sampleId: string
) {
  const active = yield* sql`SELECT 1 FROM chat_runs WHERE run_id = ${runId}
    AND status IN ${modelTurnRunStatusList} AND NOT ${executionBudgetExpired(sql, sql`metadata_json`)}`
  if (active.length === 0)
    return yield* failure("This Run has stopped or its token allowance has been spent")
  const existing =
    yield* sql`SELECT 1 FROM run_model_usage WHERE run_id = ${runId} AND sample_id = ${sampleId}`
  if (existing.length > 0) return
  const admittedAt = DateTime.formatIso(yield* DateTime.now)
  yield* sql`INSERT INTO run_model_usage (run_id, sample_id, usage_json, admitted_at)
    VALUES (${runId}, ${sampleId}, NULL, ${admittedAt})`
})
