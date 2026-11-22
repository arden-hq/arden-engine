import { JobLeaseLostError } from "@arden-hq/jobs"
import type { JobLeaseRef } from "@arden-hq/jobs"
import { Clock, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { WorkStoreError } from "../work/store.js"
import { iso } from "../../runtime/clock.js"
import { ownerJoin } from "./automation-rows.js"
import { attemptRunSessionIdSql } from "./owner-chat.js"
import { readScheduledIdentity } from "./run-context.js"

export const parseLease = (input: { readonly id: string; readonly token: string }) => {
  const queueId = Number(input.id)
  const separator = input.token.indexOf("|")
  const runId = Number(separator < 0 ? "" : input.token.slice(0, separator))
  const claimAttempt = Number(separator < 0 ? "" : input.token.slice(separator + 1))
  if (
    !Number.isSafeInteger(queueId) ||
    queueId < 1 ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(claimAttempt) ||
    claimAttempt < 1
  ) {
    throw new JobLeaseLostError(input.id)
  }
  return { queueId, runId, claimAttempt }
}

export const assertAutomationLease = Effect.fn("AutomationLease.assert")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly lease: JobLeaseRef
    readonly automationId: string
    readonly attemptId: number
    readonly sessionId: string
  }
) {
  const failure = () =>
    new WorkStoreError({ reason: "conflict", message: "The Automation lease is no longer current" })
  const parsed = yield* Effect.try({ try: () => parseLease(options.lease), catch: failure })
  if (parsed.runId !== options.attemptId) return yield* failure()
  yield* readScheduledIdentity({
    sql,
    automationId: options.automationId,
    attemptId: options.attemptId
  })
  const live = yield* sql`SELECT 1 FROM automation_event_queue AS queue
    JOIN automation_runs AS attempt ON attempt.id = ${options.attemptId} AND attempt.task_id = queue.task_id
    ${ownerJoin(sql)}
    LEFT JOIN space_review_chats AS review_chat ON review_chat.space_id = review_space.space_id
    JOIN sessions AS session ON session.session_id = ${options.sessionId}
      AND ((task.task_id IS NOT NULL
          AND (session.origin_automation_id = queue.task_id OR session.session_id = task.thread_id))
        OR (item.item_id IS NOT NULL AND attempt.item_id = item.item_id
          AND session.session_id = attempt.chat_session_id
          AND session.origin_automation_id = queue.task_id AND session.session_type = 'channel')
        OR (review_chat.session_id IS NOT NULL AND session.origin_automation_id = queue.task_id
          AND ((session.session_id = review_chat.session_id AND session.session_type = 'channel')
            OR (session.session_type = 'chat' AND session.parent_session_id = review_chat.session_id
              AND session.session_id = ${attemptRunSessionIdSql(sql, sql`review_chat.session_id`, sql`attempt.id`)}))))
    WHERE queue.id = ${parsed.queueId} AND queue.task_id = ${options.automationId} AND session.archived_at IS NULL
      AND queue.lease_expires_at > ${iso(yield* Clock.currentTimeMillis)} AND queue.claimed_at IS NOT NULL
      AND attempt.claim_count = ${parsed.claimAttempt}
      AND json_extract(queue.context, '$.automation_run_id') = attempt.id AND attempt.status = 'running'`
  if (live.length === 0) return yield* failure()
})

export const jobMayPublish = Effect.fn("AutomationLease.mayPublish")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly lease: JobLeaseRef
    readonly automationId: string
    readonly attemptId: number
  }
) {
  const parsed = yield* Effect.option(Effect.try(() => parseLease(options.lease)))
  if (parsed._tag === "None" || parsed.value.runId !== options.attemptId) return false
  const live = yield* sql`SELECT 1 FROM automation_event_queue AS queue
    JOIN automation_runs AS attempt ON attempt.id = ${options.attemptId}
      AND attempt.task_id = queue.task_id
    JOIN scheduled_tasks AS task ON task.task_id = queue.task_id AND task.enabled = 1
    WHERE queue.id = ${parsed.value.queueId} AND queue.task_id = ${options.automationId}
      AND queue.claimed_at IS NOT NULL
      AND queue.lease_expires_at > ${iso(yield* Clock.currentTimeMillis)}
      AND attempt.claim_count = ${parsed.value.claimAttempt} AND attempt.status = 'running'
      AND json_extract(queue.context, '$.automation_run_id') = attempt.id`
  return live.length > 0
})
