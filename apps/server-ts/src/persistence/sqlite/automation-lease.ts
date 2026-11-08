import { JobLeaseLostError } from "@arden-hq/jobs"
import type { JobLeaseRef } from "@arden-hq/jobs"
import { Clock, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { WorkStoreError } from "../work/store.js"
import { iso } from "../../runtime/clock.js"

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
  const live = yield* sql`SELECT 1 FROM automation_event_queue AS queue
    JOIN automation_runs AS attempt ON attempt.id = ${options.attemptId} AND attempt.task_id = queue.task_id
    JOIN scheduled_tasks AS automation ON automation.task_id = queue.task_id
    JOIN sessions AS session ON session.session_id = ${options.sessionId}
      AND (session.origin_automation_id = queue.task_id OR session.session_id = automation.thread_id)
    WHERE queue.id = ${parsed.queueId} AND queue.task_id = ${options.automationId} AND session.archived_at IS NULL
      AND queue.lease_expires_at > ${iso(yield* Clock.currentTimeMillis)} AND queue.claimed_at IS NOT NULL
      AND attempt.claim_count = ${parsed.claimAttempt}
      AND json_extract(queue.context, '$.automation_run_id') = attempt.id AND attempt.status = 'running'`
  if (live.length === 0) return yield* failure()
})
