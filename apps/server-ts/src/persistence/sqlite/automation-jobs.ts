import { JOB_SUBJECT_KIND } from "../space-job-id.js"
import { jobHeldSince } from "./automation-running.js"
import { parseLease } from "./automation-lease.js"
import { queueNextDueAt } from "./automation-next-due.js"
import {
  JobLeaseLostError,
  type JobClaimInput,
  type JobCompleteInput,
  type JobFailInput,
  type JobReleaseInput,
  type JobRenewInput
} from "@arden-hq/jobs"
import { runAuthorityState, type RunAuthorityState } from "./run-context.js"
import { type AutomationContextMode } from "@arden-hq/protocol/automations"
import { jobPrefilter } from "./automation-event-batch.js"
import { Clock, Effect } from "effect"
import { AutomationQueue } from "../automations/queue.js"
import {
  AutomationStoreError,
  type ClaimedAutomationJobLease,
  type AutomationJobSettlement
} from "../automations/store.js"
import { claimedWork, readJobChatRun, readJobHandler } from "./automation-claimed-work.js"
import {
  type QueueClaim,
  type QueueEntry,
  boundAttemptJson,
  storeError,
  decodeOwnedAttempt,
  decodeOwner,
  queueColumns,
  ownerJoin,
  ownerJson
} from "./automation-rows.js"
import { makeAutomationJobSettlement, type SettlementDeps } from "./automation-job-settlement.js"
import { iso } from "../../runtime/clock.js"
import { decodeQueueContext } from "./automation-queue-context.js"
import { makeFencedOccurrences } from "./automation-fenced-occurrence.js"
import { makeAutomationJobClaim } from "./automation-job-claim.js"

export const makeAutomationJobs = ({
  writer,
  sessionEvents,
  rules,
  diagnostics
}: SettlementDeps): AutomationQueue["Service"]["jobs"] => {
  const sql = writer.sql
  const { loadFenced, settleFenced } = makeFencedOccurrences({ writer, sessionEvents, rules })
  const { completeEffect, failEffect, releaseEffect } = makeAutomationJobSettlement({
    writer,
    sessionEvents,
    rules,
    diagnostics
  })

  const { claimEffect, claimedPrompt } = makeAutomationJobClaim({
    writer,
    sessionEvents,
    rules,
    loadFenced,
    settleFenced
  })
  const recoverExpiredEffect = Effect.fn("SqliteAutomationStore.recoverExpired")(function* () {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const released = yield* sql<{ readonly id: number }>`
        UPDATE automation_event_queue
        SET claimed_at = NULL, hold_started_at = NULL, lease_expires_at = NULL
        WHERE claimed_at IS NOT NULL
          AND task_id IN (
            SELECT task.task_id FROM scheduled_tasks AS task
            WHERE task.purpose IN ('user_automation', 'system')
              AND ${jobHeldSince(sql, "task")} IS NULL
          )
        RETURNING id
      `
          const cleared = yield* sql<{ readonly task_id: string }>`
        UPDATE scheduled_tasks
        SET job_held_since = NULL
        WHERE ${jobHeldSince(sql, "scheduled_tasks")} IS NOT NULL
          AND purpose IN ('user_automation', 'system')
          AND NOT EXISTS (
            SELECT 1 FROM automation_event_queue AS queue
            WHERE queue.task_id = scheduled_tasks.task_id
              AND queue.claimed_at IS NOT NULL
          )
        RETURNING task_id
      `
          return released.length + cleared.length
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          storeError("recover", "storage", "Could not recover Automation jobs", undefined, cause)
        )
      )
  })

  const renewEffect = Effect.fn("SqliteAutomationStore.renew")(function* (input: JobRenewInput) {
    const parsed = parseLease(input)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const now = Math.max(input.now, yield* Clock.currentTimeMillis)
          const renewed = yield* sql<{ readonly id: number }>`
      UPDATE automation_event_queue
      SET claimed_at = MAX(claimed_at, ${iso(now)}),
          lease_expires_at = MAX(lease_expires_at, ${iso(now + input.leaseDurationMs)})
      WHERE id = ${parsed.queueId} AND lease_expires_at > ${iso(now)}
        AND claimed_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM automation_runs
          WHERE id = ${parsed.runId} AND claim_count = ${parsed.claimAttempt}
            AND status = 'running' AND task_id = automation_event_queue.task_id
        )
        AND json_extract(context, '$.automation_run_id') = ${parsed.runId}
      RETURNING id
    `.pipe(
            Effect.mapError((cause) =>
              storeError("renew", "storage", "Could not renew Automation job", undefined, cause)
            )
          )
          const rows =
            renewed.length === 0
              ? []
              : yield* sql<
                  QueueEntry &
                    QueueClaim & {
                      readonly owner: string | null
                      readonly admitted_session_id: string | null
                      readonly bound: string
                    }
                >`
      SELECT ${queueColumns(sql)}, ${ownerJson(sql)} AS owner,
             attempt.chat_session_id AS admitted_session_id,
             ${boundAttemptJson(sql, "attempt")} AS bound
      FROM automation_event_queue AS queue
      ${ownerJoin(sql)}
      JOIN automation_runs AS attempt ON attempt.id = ${parsed.runId}
      WHERE queue.id = ${parsed.queueId}
    `.pipe(
                  Effect.mapError((cause) =>
                    storeError(
                      "renew",
                      "storage",
                      "Could not read renewed Automation job",
                      undefined,
                      cause
                    )
                  )
                )
          const row = rows[0]
          const owner = row === undefined ? undefined : yield* decodeOwner(row, "renew")
          if (
            row === undefined ||
            owner === undefined ||
            row.claimed_at === null ||
            row.lease_expires_at === null
          ) {
            throw new JobLeaseLostError(input.id)
          }
          const bound = yield* decodeOwnedAttempt(row, owner, "renew")
          const work = claimedWork(owner)
          const sessionId =
            owner.kind === JOB_SUBJECT_KIND.task ? row.admitted_session_id : work.chatId
          if (sessionId === null && work.handler === null) throw new JobLeaseLostError(input.id)
          const context = yield* decodeQueueContext(row, "renew")
          const run = yield* sql<{
            readonly chat_run_id: string | null
            readonly chat_session_id: string | null
            readonly context_mode: AutomationContextMode
            readonly authority: RunAuthorityState | null
          }>`
      SELECT attempt.chat_run_id, attempt.chat_session_id, attempt.context_mode,
        ${runAuthorityState(sql, sql`chat.metadata_json`, sql`chat.run_id`, sql`chat.session_id`)} AS authority
      FROM automation_runs AS attempt LEFT JOIN chat_runs AS chat ON chat.run_id = attempt.chat_run_id
      WHERE attempt.id = ${parsed.runId} AND attempt.status = 'running'
        AND attempt.claim_count = ${parsed.claimAttempt}
      LIMIT 1
    `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "renew",
                "storage",
                "Could not read renewed Automation job",
                row.task_id,
                cause
              )
            )
          )
          if (run[0] === undefined) throw new JobLeaseLostError(input.id)
          const prompt = yield* claimedPrompt(owner, run[0].context_mode, context.trigger_context)
          return {
            id: input.id,
            token: input.token,
            attempt: row.attempt_count,
            payload: {
              ...work.jobOwner,
              purpose: bound.purpose,
              name: work.name,
              automationRunId: parsed.runId,
              sessionId,
              prompt,
              model: work.model,
              chatKind: work.chatKind,
              contextMode: run[0].context_mode,
              chatRun: yield* readJobChatRun(run[0], "renew", row.task_id),
              occurrence: row.source,
              ...(context.scheduled_for === null ? {} : { scheduledFor: context.scheduled_for }),
              triggeringChange: context.triggering_change ?? null,
              prefilter: jobPrefilter(context, Date.parse(row.claimed_at)),
              ...(yield* readJobHandler(work.handler, context, "renew", row.task_id))
            },
            leasedAt: Date.parse(row.claimed_at),
            expiresAt: Date.parse(row.lease_expires_at)
          } satisfies ClaimedAutomationJobLease
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError("renew", "storage", "Could not renew Automation job", undefined, cause)
        )
      )
  })

  const jobs = {
    recoverExpired: (_now: number) => Effect.runPromise(recoverExpiredEffect()),
    claim: (input: JobClaimInput) => Effect.runPromise(claimEffect(input)),
    renew: (input: JobRenewInput) => Effect.runPromise(renewEffect(input)),
    complete: (input: JobCompleteInput<AutomationJobSettlement>) =>
      Effect.runPromise(completeEffect(input)),
    fail: (input: JobFailInput) => Effect.runPromise(failEffect(input)),
    release: (input: JobReleaseInput) => Effect.runPromise(releaseEffect(input)),
    nextDueAt: (now: number) => Effect.runPromise(queueNextDueAt(writer, now))
  }

  return jobs
}
