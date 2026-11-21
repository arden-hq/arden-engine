import { jobHeldSince } from "./automation-running.js"
import { hasPendingTaskQuestion } from "./task-question-state.js"
import { DateTime, Effect } from "effect"
import type { PersistenceDeps } from "./deps.js"
import { AutomationStoreError } from "../automations/store.js"

import type { AutomationDiagnostics, QueueRow, ScheduleRow } from "../automations/diagnostics.js"
import { activeRunStatusList } from "./status-sets.js"
import { decodeOwner, hasOwner, ownerJoin, ownerJson, type WorkOwner } from "./automation-rows.js"
import { internalRef } from "./space-jobs.js"
import { spaceJobId } from "../space-job-id.js"

const shownOwner = (
  owner: WorkOwner,
  holdStartedAt: string | null
): Pick<
  QueueRow,
  "automation_ref" | "name" | "enabled" | "held_by_worker_since" | "session_id"
> => {
  switch (owner.kind) {
    case "automation":
      return {
        automation_ref: owner.authored.ref,
        name: owner.authored.name,
        enabled: owner.state.enabled ? 1 : 0,
        held_by_worker_since: owner.state.heldSince,
        session_id: owner.authored.chatId
      }
    case "space_review":
      return {
        automation_ref: internalRef(owner.key),
        name: owner.name,
        enabled: owner.mayRun ? 1 : 0,
        held_by_worker_since: holdStartedAt,
        session_id: owner.chatId
      }
    case "task":
      return {
        automation_ref: internalRef(owner.key),
        name: owner.text,
        enabled: owner.stands ? 1 : 0,
        held_by_worker_since: holdStartedAt,
        session_id: owner.chatId
      }
  }
}

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
          let reviewKey: string | null = null
          if (automationRef !== undefined) {
            const found = yield* sql`SELECT 1 FROM scheduled_tasks
              WHERE automation_ref = ${automationRef} AND purpose IN ('user_automation', 'system')`
            if (found.length === 0) {
              const spaces = yield* sql<{ readonly space_id: string }>`SELECT space_id FROM spaces`
              reviewKey =
                spaces
                  .map((space) => spaceJobId(space.space_id))
                  .find((key) => internalRef(key) === automationRef) ?? null
            }
            if (found.length === 0 && reviewKey === null)
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
          const queued = yield* sql<
            Omit<
              QueueRow,
              "automation_ref" | "name" | "enabled" | "held_by_worker_since" | "session_id"
            > & { readonly owner: string | null; readonly hold_started_at: string | null }
          >`SELECT
      q.id AS queue_id, q.task_id, q.owner, q.hold_started_at, q.source,
      q.created_at, q.claimed_at, q.lease_expires_at, q.next_attempt_at, q.attempt_count,
      q.last_error, r.chat_run_id, c.status AS chat_status,
      (SELECT active.status FROM chat_runs active WHERE active.session_id = q.chat_id
        AND active.status IN ${activeRunStatusList} ORDER BY active.started_at DESC LIMIT 1) AS destination_chat_status,
      (q.item_id IS NOT NULL AND ${hasPendingTaskQuestion(sql, sql`q.item_id`)}) AS pending_task_question
      FROM (SELECT owned.*, json_extract(owned.owner, '$.itemId') AS item_id,
          coalesce(json_extract(owned.owner, '$.authored.chatId'),
            json_extract(owned.owner, '$.chatId')) AS chat_id,
          json_extract(owned.owner, '$.authored.ref') AS automation_ref
        FROM (SELECT queue.id, queue.task_id, queue.source, queue.context, queue.created_at,
            queue.claimed_at, queue.hold_started_at, queue.lease_expires_at, queue.next_attempt_at,
            queue.attempt_count, queue.last_error, ${ownerJson(sql)} AS owner
          FROM automation_event_queue AS queue ${ownerJoin(sql)} WHERE ${hasOwner(sql)}) AS owned
        ) AS q
      LEFT JOIN automation_runs r ON r.id = json_extract(q.context, '$.automation_run_id') AND r.task_id = q.task_id
      LEFT JOIN chat_runs c ON c.run_id = r.chat_run_id
      ORDER BY (q.automation_ref = ${automationRef ?? null} OR q.task_id = ${reviewKey}) DESC,
        (q.claimed_at IS NOT NULL) DESC, q.created_at, q.id
      LIMIT 51`
          const queue = yield* Effect.forEach(
            queued,
            ({ owner: stored, hold_started_at: holdStartedAt, ...row }) =>
              decodeOwner({ task_id: row.task_id, owner: stored }, "diagnostics").pipe(
                Effect.flatMap((owner) =>
                  owner === undefined
                    ? Effect.fail(
                        new AutomationStoreError({
                          operation: "diagnostics",
                          reason: "corrupt",
                          message: "Automation job has no owner"
                        })
                      )
                    : Effect.succeed({
                        ...row,
                        ...shownOwner(owner, holdStartedAt)
                      } satisfies QueueRow)
                )
              )
          )
          const schedules =
            yield* sql<ScheduleRow>`SELECT t.task_id, t.automation_ref, t.name, t.enabled,
      t.next_run_at, ${jobHeldSince(sql, "t")} AS held_by_worker_since, t.last_run_at, t.cooldown_minutes, t.thread_id AS session_id,
      (SELECT c.status FROM chat_runs c WHERE c.session_id = t.thread_id
        AND c.status IN ${activeRunStatusList} ORDER BY c.started_at DESC LIMIT 1) AS active_chat_status
      FROM scheduled_tasks t
      WHERE t.purpose IN ('user_automation', 'system')
        AND (t.automation_ref = ${automationRef ?? null}
          OR (t.enabled = 1 AND t.next_run_at <= ${now}))
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
