import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { endAutoPause } from "./automation-auto-pause.js"
import { restartMeasuredTriggers } from "./automation-trigger-arming.js"

export const resumeAutomation = Effect.fn("AutomationResume.resume")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly automationId: string
  readonly nextRunAt: string | null
}) {
  const { sql, automationId } = options
  yield* sql`UPDATE scheduled_tasks
    SET enabled = 1, paused_at = NULL, next_run_at = ${options.nextRunAt}
    WHERE task_id = ${automationId}`
  yield* endAutoPause(sql, automationId)
  yield* restartMeasuredTriggers(sql, automationId)
})
