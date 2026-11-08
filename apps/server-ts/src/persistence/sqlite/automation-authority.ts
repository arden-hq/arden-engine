import { DateTime, Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { closeRunAsks } from "./run-asks.js"
import { appendRunsFencedInTransaction } from "./run-fenced.js"
import type { JobPurpose } from "../job-classification.js"
import {
  announceEnded,
  endAutomationRun,
  type EndedAutomationRun
} from "./automation-run-outcome.js"
import { runHoldsWorkSql } from "./run-liveness.js"
import { openDeferredCallStatusList } from "./status-sets.js"

const worksFor = (sql: SqlClient.SqlClient, metadata: Statement.Fragment, automationId: string) =>
  sql`COALESCE(json_extract(${metadata}, '$.run_policy.automation_id'),
    json_extract(${metadata}, '$.automation.task_id')) = ${automationId}`

export const revokeAutomationWork = Effect.fn("AutomationAuthority.revoke")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly automationId: string
  readonly settlingRunId?: string | undefined
}) {
  const { sql, automationId } = options
  const now = DateTime.formatIso(yield* DateTime.now)
  const fenced = yield* sql<{
    readonly run_id: string
    readonly session_id: string
  }>`UPDATE chat_runs SET metadata_json = json_set(metadata_json, '$.cancelled_by_run_id',
      COALESCE(json_extract(metadata_json, '$.cancelled_by_run_id'), run_id))
    WHERE ${runHoldsWorkSql(sql, "chat_runs")}
      AND ${worksFor(sql, sql`metadata_json`, automationId)}
      AND run_id IS NOT ${options.settlingRunId ?? null}
    RETURNING run_id, session_id`
  yield* appendRunsFencedInTransaction(sql, options.sessionEvents, fenced)
  yield* closeRunAsks({
    sql,
    runs: sql`SELECT run.run_id FROM (
        SELECT run_id FROM run_questions WHERE resolution IS NULL AND closed_at IS NULL
        UNION SELECT run_id FROM deferred_tool_calls WHERE status IN ${openDeferredCallStatusList}
      ) AS asking JOIN chat_runs AS run ON run.run_id = asking.run_id
      WHERE ${worksFor(sql, sql`run.metadata_json`, automationId)}
        AND run.run_id IS NOT ${options.settlingRunId ?? null}`,
    now
  })
  const retired = yield* sql<{
    readonly id: number
    readonly purpose: JobPurpose
    readonly chat_run_id: string | null
    readonly chat_session_id: string | null
  }>`SELECT attempt.id, task.purpose, attempt.chat_run_id, attempt.chat_session_id
    FROM automation_runs AS attempt JOIN scheduled_tasks AS task ON task.task_id = attempt.task_id
    WHERE attempt.task_id = ${automationId} AND attempt.status = 'running'
      AND NOT EXISTS (SELECT 1 FROM chat_runs AS run
        WHERE json_extract(run.metadata_json, '$.run_context.origin') = attempt.origin)`
  for (const attempt of retired) {
    const run: EndedAutomationRun = {
      id: attempt.id,
      outcome: "superseded",
      endedAt: now,
      result: null,
      error: "Automation authority changed before Run admission",
      chatRunId: attempt.chat_run_id,
      chatSessionId: attempt.chat_session_id,
      skip: null
    }
    yield* endAutomationRun(sql, run)
    yield* announceEnded(options.sessionEvents, { automationId, purpose: attempt.purpose, run })
  }
  if (retired.length > 0) {
    yield* sql`DELETE FROM automation_event_queue WHERE task_id = ${automationId}
      AND json_extract(context, '$.automation_run_id') IN ${sql.in(retired.map((row) => row.id))}`
    yield* sql`UPDATE scheduled_tasks SET running_since = NULL WHERE task_id = ${automationId}
      AND NOT EXISTS (SELECT 1 FROM automation_runs WHERE task_id = ${automationId} AND status = 'running')`
  }
})
