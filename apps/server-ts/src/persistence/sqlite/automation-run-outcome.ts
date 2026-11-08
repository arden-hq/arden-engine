import { ranOutcome, runStatusOf, type AutomationRunOutcome } from "@arden-hq/protocol/automations"
import { AutomationRunOutcomeSchema } from "@arden-hq/protocol/effect/automations"
import { Effect, Schema } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import type { StoredAutomationRunSkip } from "../automations/store.js"
import type { JobPurpose } from "../job-classification.js"
import type { Backfill } from "./backfills/backfill.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { endedUnsuccessfullyAutomationRunStatusList } from "./status-sets.js"

export interface EndedAutomationRun {
  readonly id: number
  readonly outcome: AutomationRunOutcome
  readonly endedAt: string
  readonly result: string | null
  readonly error: string | null
  readonly chatRunId: string | null
  readonly chatSessionId: string | null
  readonly skip: StoredAutomationRunSkip | null
}

export const endAutomationRun = Effect.fn("AutomationRunOutcome.end")(function* (
  sql: SqlClient.SqlClient,
  run: EndedAutomationRun
) {
  const ended = yield* sql<{ readonly id: number }>`UPDATE automation_runs
    SET outcome = ${run.outcome}, status = ${storedStatus(run.outcome)}, ended_at = ${run.endedAt},
      result = ${run.result}, error = ${run.error},
      chat_run_id = ${run.chatRunId}, chat_session_id = ${run.chatSessionId},
      skip_json = ${run.skip === null ? null : JSON.stringify(run.skip)}
    WHERE id = ${run.id} AND status = 'running'
    RETURNING id`
  return ended.length === 1
})

export const announceEnded = (
  sessionEvents: SessionLifecycleEvents["Service"],
  input: {
    readonly automationId: string
    readonly purpose: JobPurpose
    readonly run: EndedAutomationRun
  }
) =>
  sessionEvents.appendEventInTransaction({
    type: "automation_finished",
    task_id: input.automationId,
    purpose: input.purpose,
    outcome: input.run.outcome,
    result: input.run.result,
    error: input.run.error,
    run_id: input.run.chatRunId,
    run_session_id: input.run.chatRunId === null ? null : input.run.chatSessionId
  })

export const shownRunStatus = (outcome: string | null) =>
  outcome === null
    ? Effect.succeed("running" as const)
    : Schema.decodeUnknownEffect(AutomationRunOutcomeSchema)(outcome).pipe(Effect.map(runStatusOf))

const storedStatus = (
  outcome: AutomationRunOutcome
): "completed" | "failed" | "cancelled" | "interrupted" => {
  if (ranOutcome(outcome)) return "completed"
  if (outcome === "cancelled" || outcome === "interrupted") return outcome
  return "failed"
}

export const outcomeSql = (sql: SqlClient.SqlClient, run: Statement.Fragment) =>
  sql`COALESCE(${run}.outcome, ${legacyOutcomeSql(sql, run)})`

const legacyOutcomeSql = (sql: SqlClient.SqlClient, run: Statement.Fragment) => sql`CASE
    WHEN ${run}.status = 'running' THEN NULL
    WHEN ${run}.skip_json IS NOT NULL THEN CASE json_extract(${run}.skip_json, '$.reason')
      WHEN 'prefilter' THEN 'skipped:prefilter'
      WHEN 'space_review_gate' THEN 'skipped:space_review_gate' END
    WHEN ${run}.disposition = 'superseded' THEN 'superseded'
    WHEN ${run}.status IN ${endedUnsuccessfullyAutomationRunStatusList} THEN ${run}.status
    WHEN ${run}.disposition = 'needs_you' THEN 'needs_you'
    WHEN EXISTS (SELECT 1 FROM run_sidecars AS sidecar WHERE sidecar.run_id = ${run}.chat_run_id
      AND json_extract(sidecar.evidence_json, '$.automation_outcome') IS NOT NULL) THEN 'blocked'
    WHEN ${run}.disposition IN ('no_change', 'skipped_no_input') THEN 'no_change'
    ELSE 'finished' END`

export const runOutcomeBackfill: Backfill = {
  name: "run_outcome",
  chunk: Effect.fn("AutomationRunOutcome.backfill")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM automation_runs
      WHERE id > ${Number(cursor ?? 0)} ORDER BY id LIMIT ${limit}`
    const last = rows.at(-1)
    if (last === undefined) return { converted: 0, next: undefined }
    const converted = yield* sql<{ readonly id: number }>`UPDATE automation_runs AS run
      SET outcome = ${legacyOutcomeSql(sql, sql`run`)}
      WHERE run.id > ${Number(cursor ?? 0)} AND run.id <= ${last.id}
        AND run.outcome IS NULL AND run.status <> 'running'
        AND ${legacyOutcomeSql(sql, sql`run`)} IS NOT NULL
      RETURNING id`
    return { converted: converted.length, next: String(last.id) }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
      FROM automation_runs AS run WHERE run.outcome IS NULL AND run.status <> 'running'
        AND ${legacyOutcomeSql(sql, sql`run`)} IS NOT NULL`
    return rows[0]?.count ?? 0
  })
}
