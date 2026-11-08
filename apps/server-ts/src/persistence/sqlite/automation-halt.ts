import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { AutomationQueueSource } from "../automations/store.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { revokeAutomationWork } from "./automation-authority.js"
import { dropMeasuredRows } from "./automation-trigger-arming.js"
import { freshRow } from "./automation-enqueue.js"

export type AutomationHalt = "pause" | "hold" | "stop"

const DROPS: Readonly<Record<AutomationHalt, ReadonlyArray<AutomationQueueSource>>> = {
  pause: ["scheduled", "wake"],
  hold: [],
  stop: ["scheduled", "wake", "event", "idle", "count", "manual"]
}

export const haltAutomation = Effect.fn("AutomationHalt.halt")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly automationId: string
  readonly halt: AutomationHalt
  readonly settlingRunId?: string | undefined
}) {
  const { sql, automationId, halt } = options
  const pausedAt =
    halt === "pause"
      ? sql`COALESCE(paused_at, ${DateTime.formatIso(yield* DateTime.now)})`
      : sql`NULL`
  yield* sql`UPDATE scheduled_tasks
    SET enabled = 0, next_run_at = NULL, paused_at = ${pausedAt}
    WHERE task_id = ${automationId}`
  if (halt !== "hold")
    yield* revokeAutomationWork({
      sql,
      sessionEvents: options.sessionEvents,
      automationId,
      settlingRunId: options.settlingRunId
    })
  const drops = DROPS[halt]
  if (halt === "pause") yield* dropMeasuredRows(sql, automationId)
  if (drops.length === 0) return
  if (drops.includes("manual")) {
    const at = DateTime.formatIso(yield* DateTime.now)
    yield* sql`UPDATE automation_runs
      SET skip_json = json_set(skip_json, '$.ran', json('null'), '$.cancelled', json_object('at', ${at}))
      WHERE task_id = ${automationId}
        AND id IN (SELECT json_extract(queue.context, '$.from_skipped_run')
          FROM automation_event_queue AS queue
          WHERE queue.task_id = ${automationId} AND ${freshRow(sql)} AND queue.source = 'manual')`
  }
  yield* sql`DELETE FROM automation_event_queue
    WHERE task_id = ${automationId} AND ${freshRow(sql)} AND source IN ${sql.in(drops)}`
})
