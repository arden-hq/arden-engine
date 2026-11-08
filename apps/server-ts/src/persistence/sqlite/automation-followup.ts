import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { AutomationQueue, FollowupOwner } from "../automations/queue.js"
import { AutomationStoreError } from "../automations/store.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { storeError } from "./automation-rows.js"
import { executionBudgetExpired } from "./execution-budgets.js"
import { runPolicyRevoked } from "./run-policy.js"
import { modelTurnRunStatusList } from "./status-sets.js"
import { userAutomationSql } from "./authority-sql.js"

export const makeAutomationFollowup = ({
  writer
}: Pick<AutomationStoreDeps, "writer">): AutomationQueue["Service"]["setFollowup"] =>
  Effect.fn("AutomationFollowup.record")(function* (input) {
    const sql = writer.sql
    const now = yield* DateTime.now
    const at =
      input.followup.action === "check_again"
        ? yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(input.followup.at).pipe(
            Effect.mapError(() =>
              storeError("update", "invalid", "The next check needs an ISO timestamp")
            )
          )
        : undefined
    if (at !== undefined && DateTime.toEpochMillis(at) <= DateTime.toEpochMillis(now))
      return yield* storeError("update", "invalid", "The next check must be in the future")
    const decision = JSON.stringify({
      run_id: input.chatRunId,
      action: input.followup.action,
      at: at === undefined ? null : DateTime.formatIso(at)
    })
    return yield* writer
      .run(
        Effect.gen(function* () {
          const updated =
            yield* sql<FollowupOwner>`UPDATE automation_runs SET followup_json = json_set(${decision}, '$.generation',
          (SELECT followup_generation FROM scheduled_tasks WHERE task_id = automation_runs.task_id))
        WHERE id IN (
          SELECT attempt.id FROM automation_runs AS attempt
          JOIN chat_runs AS run ON run.session_id = attempt.chat_session_id
            AND json_extract(run.metadata_json, '$.run_context.origin') = json(attempt.origin)
          JOIN scheduled_tasks AS task ON task.task_id = attempt.task_id
          JOIN automation_event_queue AS queue ON queue.task_id = task.task_id
            AND json_extract(queue.context, '$.automation_run_id') = attempt.id
          WHERE run.run_id = ${input.chatRunId} AND run.session_id = ${input.sessionId}
            AND run.status IN ${modelTurnRunStatusList} AND attempt.status = 'running'
            AND ${userAutomationSql("task")} AND task.enabled = 1
            AND queue.claimed_at IS NOT NULL AND queue.lease_expires_at > ${DateTime.formatIso(now)}
            AND NOT ${executionBudgetExpired(sql, sql`run.metadata_json`)}
            AND NOT ${runPolicyRevoked(sql, sql`run.metadata_json`)}
        ) RETURNING task_id,
          (SELECT automation_ref FROM scheduled_tasks WHERE task_id = automation_runs.task_id) AS automation_ref,
          (SELECT name FROM scheduled_tasks WHERE task_id = automation_runs.task_id) AS name`
          const [owner] = updated
          if (owner === undefined || updated.length !== 1)
            return yield* storeError(
              "update",
              "conflict",
              "Only the active owning Automation run can change its follow-up; it may have been paused or changed"
            )
          return owner
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError("update", "storage", "Could not save the follow-up", undefined, cause)
        )
      )
  })

export const readAutomationFollowup = Effect.fn("AutomationFollowup.read")(function* (
  sql: SqlClient.SqlClient,
  attemptId: number,
  runId: string | null
) {
  const rows = yield* sql<{ readonly action: string; readonly at: string | null }>`
    SELECT json_extract(attempt.followup_json, '$.action') AS action,
           json_extract(attempt.followup_json, '$.at') AS at
    FROM automation_runs AS attempt
    JOIN chat_runs AS run ON run.run_id = ${runId}
    JOIN chat_runs AS owner ON owner.run_id = json_extract(attempt.followup_json, '$.run_id')
    JOIN scheduled_tasks AS task ON task.task_id = attempt.task_id
    WHERE attempt.id = ${attemptId} AND ${userAutomationSql("task")} AND task.enabled = 1
      AND run.status = 'completed' AND owner.status = 'completed'
      AND run.session_id = attempt.chat_session_id AND owner.session_id = attempt.chat_session_id
      AND json_extract(run.metadata_json, '$.run_context.origin') = json(attempt.origin)
      AND json_extract(owner.metadata_json, '$.run_context.origin') = json(attempt.origin)
      AND json_extract(attempt.followup_json, '$.generation') = task.followup_generation
      AND NOT ${executionBudgetExpired(sql, sql`owner.metadata_json`)}
      AND NOT ${runPolicyRevoked(sql, sql`owner.metadata_json`)}
  `
  return rows[0]
})
