import { hasPendingTaskQuestion } from "./task-question-state.js"
import { DateTime, Effect } from "effect"
import type { PersistenceDeps } from "./deps.js"
import { AutomationStoreError } from "../automations/store.js"

import type { AutomationDiagnostics, QueueRow, ScheduleRow } from "../automations/diagnostics.js"
import { activeRunStatusList } from "./status-sets.js"

export const makeAutomationDiagnostics = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">) =>
  Effect.fn("SqliteAutomationStore.diagnostics")(function* (
    automationRef?: string
  ): Effect.fn.Return<AutomationDiagnostics, AutomationStoreError> {
    const now = DateTime.formatIso(yield* DateTime.now)
    const sql = reader
    return yield* writer
      .snapshot(
        Effect.gen(function* () {
          if (automationRef !== undefined) {
            const found =
              yield* sql`SELECT 1 FROM scheduled_tasks WHERE automation_ref = ${automationRef}`
            if (found.length === 0)
              return yield* new AutomationStoreError({
                operation: "diagnostics",
                reason: "not_found",
                message: "Automation no longer exists"
              })
          }
          const counts = yield* sql<AutomationDiagnostics["queue_counts"]>`SELECT
      count(*) AS total,
      coalesce(sum(claimed_at IS NOT NULL AND lease_expires_at > ${now}), 0) AS leased,
      coalesce(sum(claimed_at IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})), 0) AS expired,
      coalesce(sum(claimed_at IS NULL), 0) AS unclaimed,
      coalesce(sum(claimed_at IS NULL AND next_attempt_at > ${now}), 0) AS deferred
      FROM automation_event_queue`
          const queue = yield* sql<QueueRow>`SELECT
      q.id AS queue_id, q.task_id, t.automation_ref, t.name, q.source, t.enabled,
      q.created_at, q.claimed_at, q.lease_expires_at, q.next_attempt_at, q.attempt_count,
      q.last_error, t.running_since, r.chat_run_id, c.status AS chat_status,
      (SELECT active.status FROM chat_runs active WHERE active.session_id = t.thread_id
        AND active.status IN ${activeRunStatusList} ORDER BY active.started_at DESC LIMIT 1) AS destination_chat_status,
      (t.purpose = 'task_execution' AND ${hasPendingTaskQuestion(sql, sql`t.owner_task_id`)}) AS pending_task_question,
      t.thread_id AS session_id
      FROM automation_event_queue q JOIN scheduled_tasks t ON t.task_id = q.task_id
      LEFT JOIN automation_runs r ON r.id = json_extract(q.context, '$.automation_run_id') AND r.task_id = q.task_id
      LEFT JOIN chat_runs c ON c.run_id = r.chat_run_id
      ORDER BY (t.automation_ref = ${automationRef ?? null}) DESC, (q.claimed_at IS NOT NULL) DESC, q.created_at, q.id
      LIMIT 51`
          const schedules =
            yield* sql<ScheduleRow>`SELECT t.task_id, t.automation_ref, t.name, t.enabled,
      t.next_run_at, t.running_since, t.last_run_at, t.cooldown_minutes, t.thread_id AS session_id,
      (SELECT c.status FROM chat_runs c WHERE c.session_id = t.thread_id
        AND c.status IN ${activeRunStatusList} ORDER BY c.started_at DESC LIMIT 1) AS active_chat_status
      FROM scheduled_tasks t
      WHERE t.automation_ref = ${automationRef ?? null}
        OR (t.enabled = 1 AND t.next_run_at <= ${now})
      ORDER BY (t.automation_ref = ${automationRef ?? null}) DESC, t.next_run_at, t.task_id
      LIMIT 21`
          const queueCounts = counts[0]
          if (queueCounts === undefined)
            return yield* new AutomationStoreError({
              operation: "diagnostics",
              reason: "storage",
              message: "Automation queue counts returned no row"
            })
          return {
            observed_at: now,
            selected_automation_ref: automationRef ?? null,
            queue_counts: queueCounts,
            queue: queue.slice(0, 50),
            queue_has_more: queue.length > 50,
            schedules: schedules.slice(0, 20),
            schedules_has_more: schedules.length > 20
          }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : new AutomationStoreError({
                operation: "diagnostics",
                reason: "storage",
                message: "Could not read automation diagnostics",
                cause
              })
        )
      )
  })
