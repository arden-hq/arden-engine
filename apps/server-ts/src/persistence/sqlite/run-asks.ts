import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { closeQuestionInTransaction } from "./question-settle.js"
import { openDeferredCallStatusList } from "./status-sets.js"

export const hasOpenRunAsks = Effect.fn("RunAsks.hasOpen")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql`SELECT 1 FROM run_questions
    WHERE run_id = ${runId} AND resolution IS NULL AND closed_at IS NULL
    UNION ALL
    SELECT 1 FROM deferred_tool_calls
    WHERE run_id = ${runId} AND status IN ${openDeferredCallStatusList}
    LIMIT 1`
  return rows.length > 0
})

export const closeRunAsks = Effect.fn("RunAsks.close")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly runs: Statement.Fragment
  readonly now: string
}) {
  const { sql, runs, now } = options
  const open = yield* sql<{ readonly question_id: string }>`SELECT question_id FROM run_questions
    WHERE run_id IN (${runs}) AND resolution IS NULL AND closed_at IS NULL`
  for (const question of open)
    yield* closeQuestionInTransaction({
      sql,
      questionId: question.question_id,
      timer: "cancelled",
      now
    })
  yield* sql`UPDATE deferred_tool_calls SET status = 'rejected',
      resolved_at = COALESCE(resolved_at, ${now})
    WHERE run_id IN (${runs}) AND status IN ${openDeferredCallStatusList}`
})
