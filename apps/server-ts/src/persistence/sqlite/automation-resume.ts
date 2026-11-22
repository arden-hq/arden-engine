import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { AutomationRules } from "../automations/model.js"
import { iso } from "../../runtime/clock.js"
import { userAutomationSql } from "./authority-sql.js"
import { endAutoPause } from "./automation-auto-pause.js"
import { listenerTriggers } from "./automation-schedule.js"
import { restartMeasuredTriggers } from "./automation-trigger-arming.js"

export const resumeAutomation = Effect.fn("AutomationResume.resume")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly automationId: string
  readonly nextRunAt: string | null
}) {
  const { sql, automationId } = options
  yield* sql`UPDATE scheduled_tasks
    SET enabled = 1, paused_at = NULL, next_run_at = ${options.nextRunAt},
      auto_resume_at = NULL, auto_resumes = 0
    WHERE task_id = ${automationId}`
  yield* endAutoPause(sql, automationId)
  yield* restartMeasuredTriggers(sql, automationId)
  yield* restartAutomationPositions(sql, automationId)
})

/** The `monitor_state` row of a position an Automation keeps; resuming the Automation restarts it. */
export const automationPositionNamespace = (automationId: string): string => automationId

const restartAutomationPositions = (sql: SqlClient.SqlClient, automationId: string) =>
  sql`DELETE FROM monitor_state WHERE namespace = ${automationPositionNamespace(automationId)}`

export const resumeDueAutomations = Effect.fn("AutomationResume.resumeDue")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly rules: AutomationRules["Service"]
  readonly now: string
}) {
  const { sql, rules, now } = options
  const due = yield* sql<{
    readonly task_id: string
    readonly triggers: string
    readonly auto_resumes: number
  }>`
    SELECT task.task_id, task.triggers, task.auto_resumes
    FROM scheduled_tasks AS task
    WHERE ${userAutomationSql("task")} AND task.enabled = 0
      AND task.auto_resume_at IS NOT NULL AND task.auto_resume_at <= ${now}
      AND NOT EXISTS (
        SELECT 1 FROM sessions AS chat JOIN spaces AS space ON space.space_id = chat.space_id
        WHERE chat.session_id = task.thread_id AND space.archived_at IS NOT NULL
      )
    ORDER BY task.auto_resume_at, task.task_id`
  for (const row of due) {
    yield* resumeOnTriggers({ sql, rules, row, now })
    yield* sql`UPDATE scheduled_tasks SET auto_resumes = ${row.auto_resumes + 1}
      WHERE task_id = ${row.task_id}`
  }
})

export const resumeOnTriggers = Effect.fn("AutomationResume.resumeOnTriggers")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly rules: AutomationRules["Service"]
  readonly row: { readonly task_id: string; readonly triggers: string }
  readonly now: string
}) {
  const { rules, row, now } = options
  const triggers = yield* listenerTriggers(row)
  const next =
    triggers === undefined
      ? null
      : yield* Effect.try(() => rules.nextRunAt(rules.triggers(triggers), Date.parse(now))).pipe(
          Effect.orElseSucceed(() => null)
        )
  yield* resumeAutomation({
    sql: options.sql,
    automationId: row.task_id,
    nextRunAt: next === null ? null : iso(next)
  })
})
