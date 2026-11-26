import { RUN_ORIGIN } from "@arden-hq/protocol/runs"
import { JOB_SUBJECT_KIND } from "../space-job-id.js"
import { jobHeldSince } from "./automation-running.js"
import { triggerContextForClaim } from "./automation-occurrence.js"
import { enqueue, holdForCooldown } from "./automation-enqueue.js"
import { dropClosedAsks } from "./automation-ask-feed.js"
import { resumeDueAutomations } from "./automation-resume.js"
import { reopenDeferredTasks } from "./work-lifecycle.js"
import { type JobClaimInput } from "@arden-hq/jobs"
import {
  captureRunTask,
  runAuthorityState,
  queueOccurrenceId,
  scheduledRunOrigin,
  type RunAuthorityState
} from "./run-context.js"
import { hasPendingTaskApproval, hasPendingTaskQuestion } from "./task-question-state.js"
import {
  AUTOMATION_EVENT_TYPE,
  AUTOMATION_OCCURRENCE,
  type AutomationContextMode
} from "@arden-hq/protocol/automations"
import {
  batchAtClaim,
  heldBehindProducer,
  jobPrefilter,
  withEventText
} from "./automation-event-batch.js"
import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { Effect } from "effect"
import { wakeChainDepth } from "../automations/chain-depth.js"
import { AutomationStoreError, type ClaimedAutomationJobLease } from "../automations/store.js"
import {
  claimedWork,
  isJobHandlerId,
  jobHandler,
  readJobChatRun,
  unknownHandlerMessage
} from "./automation-claimed-work.js"
import { encodeJson } from "./json.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import {
  type QueueClaim,
  type QueueEntry,
  boundAttemptJson,
  storeError,
  decodeOwnedAttempt,
  decodeOwner,
  queueColumns,
  hasOwner,
  ownerJoin,
  ownerJson,
  reviewMayRunSql
} from "./automation-rows.js"
import { type SettlementDeps } from "./automation-job-settlement.js"
import { makeOwnerChats } from "./owner-chat.js"
import { taskStandsSql } from "./task-wake.js"
import { iso } from "../../runtime/clock.js"
import { activeRunStatusList } from "./status-sets.js"
import { decodeQueueContext, encodeQueueContext } from "./automation-queue-context.js"
import { makeFencedOccurrences } from "./automation-fenced-occurrence.js"
import { makeClaimedPrompt } from "./automation-claimed-prompt.js"
import { skipRan } from "./automation-run-rows.js"
import { type AutomationJobClaim } from "./automation-job-claim-types.js"

const nextLeaseStamp = (epochMs: number, previous: string | null): string => {
  const previousMs = previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous)
  return iso(Math.max(epochMs, Number.isFinite(previousMs) ? previousMs + 1 : epochMs))
}

export const makeAutomationJobClaim = ({
  writer,
  sessionEvents,
  rules,
  loadFenced,
  settleFenced
}: Pick<SettlementDeps, "writer" | "sessionEvents" | "rules"> & {
  readonly loadFenced: ReturnType<typeof makeFencedOccurrences>["loadFenced"]
  readonly settleFenced: ReturnType<typeof makeFencedOccurrences>["settleFenced"]
}): AutomationJobClaim => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const claimedPrompt = makeClaimedPrompt(sql)

  const { openChat, isLiveChat } = makeOwnerChats(sql, sessionEvents)

  const materializeDue = Effect.fn("SqliteAutomationStore.materializeDue")(function* (now: string) {
    const due = yield* sql<{ readonly task_id: string; readonly next_run_at: string }>`
      SELECT task_id, next_run_at
      FROM scheduled_tasks AS task
      WHERE purpose IN ('user_automation', 'system') AND enabled = 1
        AND next_run_at IS NOT NULL
        AND next_run_at <= ${now}
        AND ${jobHeldSince(sql, "task")} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM automation_event_queue AS queued
          WHERE queued.task_id = task.task_id
            AND queued.source = 'scheduled'
            AND queued.event_key = task.next_run_at
        )
      ORDER BY next_run_at, task_id
      LIMIT 100
    `
    for (const task of due)
      yield* enqueue(
        { sql, sessionEvents },
        {
          automationId: task.task_id,
          source: "scheduled",
          key: task.next_run_at,
          pending: "add",
          context: { scheduled_for: task.next_run_at, automation_run_id: null }
        }
      )
  })

  const claimEffect = Effect.fn("SqliteAutomationStore.claim")(function* (input: JobClaimInput) {
    const nowText = iso(input.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          for (const task of yield* reopenDeferredTasks({ sql, sessionEvents }, nowText))
            yield* spaceJobs.queueTaskWake(task.item_id, nowText, { kind: "continuation" })
          yield* resumeDueAutomations({ sql, rules, now: nowText })
          yield* materializeDue(nowText)
          yield* spaceJobs.materializeDue(nowText)
          yield* dropClosedAsks(sql, nowText)
          const leases: Array<ClaimedAutomationJobLease> = []
          while (leases.length < input.limit) {
            const candidates = yield* sql<
              QueueEntry &
                QueueClaim & {
                  readonly owner: string | null
                  readonly admitted_run_id: number | null
                  readonly admitted_session_id: string | null
                  readonly bound: string | null
                }
            >`
            SELECT ${queueColumns(sql)}, ${ownerJson(sql)} AS owner,
                   admitted.id AS admitted_run_id, admitted.chat_session_id AS admitted_session_id,
                   CASE WHEN admitted.id IS NOT NULL THEN ${boundAttemptJson(sql, "admitted")} END
                     AS bound
            FROM automation_event_queue AS queue
            ${ownerJoin(sql)}
            LEFT JOIN sessions AS run_chat ON run_chat.session_id = task.thread_id
            LEFT JOIN automation_runs AS admitted
              ON admitted.id = json_extract(queue.context, '$.automation_run_id')
                AND admitted.task_id = queue.task_id
            WHERE ${hasOwner(sql)}
              AND (queue.next_attempt_at IS NULL OR queue.next_attempt_at <= ${nowText})
              AND (item.item_id IS NULL OR admitted.chat_run_id IS NOT NULL
                OR json_extract(queue.context, '$.person_change_at') IS NOT NULL
                OR item.next_attempt_at IS NULL OR item.next_attempt_at <= ${nowText})
              -- A Task moved to the background during its step in a chat goes on
              -- from where that step ends, not beside it.
              AND (item.item_id IS NULL OR admitted.chat_run_id IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM chat_runs AS step
                  WHERE json_extract(step.metadata_json, '$.run_context.task.item_id') = item.item_id
                    AND json_extract(step.metadata_json, '$.run_context.origin.kind') = 'chat'
                    AND json_extract(step.metadata_json, '$.run_context.origin.session_id') =
                      item.home_session_id
                    AND step.status IN ${activeRunStatusList}))
              AND NOT ${heldBehindProducer(sql, "queue")}
              AND (review_space.space_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM automation_event_queue AS earlier
                JOIN automation_runs AS waiting ON waiting.id = json_extract(earlier.context, '$.automation_run_id')
                  AND waiting.task_id = earlier.task_id AND waiting.status = 'running'
                WHERE earlier.task_id = queue.task_id AND earlier.id != queue.id
                  AND (earlier.created_at < queue.created_at OR (earlier.created_at = queue.created_at AND earlier.id < queue.id))
              ))
              AND (item.item_id IS NULL OR NOT ${hasPendingTaskQuestion(sql, sql`item.item_id`)}
                OR admitted.chat_run_id IS NOT NULL
                OR (json_extract(queue.context, '$.person_change_at') IS NOT NULL
                  AND NOT ${hasPendingTaskApproval(sql, sql`item.item_id`)}))
              AND CASE WHEN task.task_id IS NOT NULL THEN
                (queue.claimed_at IS NULL AND ${jobHeldSince(sql, "task")} IS NULL)
                OR
                (queue.claimed_at IS NOT NULL AND queue.lease_expires_at <= ${nowText}
                  AND ${jobHeldSince(sql, "task")} IS NOT NULL)
              ELSE
                (queue.claimed_at IS NULL AND NOT EXISTS (
                  SELECT 1 FROM automation_event_queue AS working
                  WHERE working.task_id = queue.task_id AND working.claimed_at IS NOT NULL))
                OR
                (queue.claimed_at IS NOT NULL AND queue.lease_expires_at <= ${nowText})
              END
              -- An Automation that is off runs nothing new, a run you asked for by
              -- hand included: it waits for the resume (automation-halt.ts). A
              -- Task is on while it stands, and a review while its Space lets it run.
              AND (CASE WHEN task.task_id IS NOT NULL THEN task.enabled = 1
                  WHEN review_space.space_id IS NOT NULL THEN ${reviewMayRunSql(sql, "review_space")}
                  ELSE ${taskStandsSql(sql, "item")} END
                OR admitted.chat_run_id IS NOT NULL)
              -- A user's Automation waits for its own chat to be free. A run that
              -- reads one of your chats works in a copy of it, so nothing waits.
              AND (
                task.purpose IS NOT 'user_automation'
                OR admitted.chat_run_id IS NOT NULL
                OR (run_chat.origin_automation_id IS NOT task.task_id AND task.context_mode = 'continue')
                OR NOT EXISTS (
                  SELECT 1
                  FROM chat_runs AS active_run
                  JOIN sessions AS own ON own.session_id = active_run.session_id
                  WHERE own.origin_automation_id = task.task_id AND own.session_type = 'channel'
                    AND active_run.status IN ${activeRunStatusList}
                )
              )
            ORDER BY queue.created_at, queue.id
            LIMIT 1
          `
            const candidate = candidates[0]
            if (candidate === undefined) break
            if (
              candidate.admitted_run_id === null &&
              (yield* holdForCooldown(sql, candidate, input.now))
            )
              continue
            const owner = yield* decodeOwner(candidate, "claim")
            if (owner === undefined) {
              return yield* storeError(
                "claim",
                "corrupt",
                "Automation job has no owner",
                candidate.task_id
              )
            }
            const bound =
              candidate.bound === null
                ? undefined
                : yield* decodeOwnedAttempt(
                    { task_id: candidate.task_id, bound: candidate.bound },
                    owner,
                    "claim"
                  )
            const work = claimedWork(owner)
            let sessionId: string | null
            switch (owner.kind) {
              case JOB_SUBJECT_KIND.task:
                sessionId =
                  candidate.admitted_session_id ??
                  owner.chatId ??
                  (yield* openChat({
                    owner,
                    name: owner.text,
                    spaceId: owner.spaceId,
                    model: null,
                    now: nowText
                  }))
                break
              case JOB_SUBJECT_KIND.spaceReview:
                sessionId =
                  work.chatId !== null && (yield* isLiveChat(work.chatId))
                    ? work.chatId
                    : yield* openChat({
                        owner,
                        name: work.name,
                        spaceId: owner.spaceId,
                        model: work.model,
                        now: nowText
                      })
                break
              case JOB_SUBJECT_KIND.automation:
                if (work.chatId === null && work.handler === null) {
                  return yield* storeError(
                    "claim",
                    "corrupt",
                    "Automation has no Chat session",
                    candidate.task_id
                  )
                }
                sessionId =
                  work.chatId === null || (yield* isLiveChat(work.chatId))
                    ? work.chatId
                    : yield* openChat({
                        owner,
                        name: work.name,
                        spaceId: work.job.owner_space_id,
                        model: work.model,
                        now: nowText
                      })
                break
            }
            let context = yield* decodeQueueContext(candidate, "claim")
            if (context.automation_run_id === null) {
              context = yield* batchAtClaim({
                sql,
                row: {
                  id: candidate.id,
                  task_id: candidate.task_id,
                  purpose: work.job.purpose,
                  handler: work.handler,
                  source: candidate.source,
                  attempt_count: candidate.attempt_count,
                  cooldown_minutes: work.cooldownMinutes,
                  created_at: candidate.created_at
                },
                context,
                now: nowText
              })
              if (
                candidate.source === AUTOMATION_OCCURRENCE.event ||
                candidate.source === AUTOMATION_OCCURRENCE.manual
              )
                context = withEventText(context, input.now, work.cooldownMinutes)
            }
            const stamp = nextLeaseStamp(input.now, candidate.claimed_at)
            const startedAt = work.heldSince ?? nowText
            const rowHoldStart = candidate.claimed_at === null ? nowText : candidate.hold_started_at
            yield* sql`
            UPDATE automation_event_queue
            SET claimed_at = ${stamp}, lease_expires_at = ${iso(Date.parse(stamp) + input.leaseDurationMs)}, attempt_count = attempt_count + 1,
                hold_started_at = ${owner.kind === JOB_SUBJECT_KIND.automation ? null : rowHoldStart},
                last_error = NULL
            WHERE id = ${candidate.id}
              AND claimed_at IS ${candidate.claimed_at}
          `
            if (owner.kind === JOB_SUBJECT_KIND.automation)
              yield* sql`
              UPDATE scheduled_tasks
              SET job_held_since = ${startedAt}
              WHERE task_id = ${owner.key}
            `
            let automationRunId = context.automation_run_id
            if (automationRunId === null) {
              const trigger = triggerContextForClaim({
                context,
                source: candidate.source,
                createdAt: candidate.created_at
              })
              const triggerJson =
                trigger === undefined
                  ? null
                  : yield* encodeJson(AutomationTriggerContextSchema, trigger)
              const origin = scheduledRunOrigin({
                job: work.job,
                automationId: candidate.task_id,
                occurrenceId: queueOccurrenceId(candidate),
                chainDepth: wakeChainDepth(trigger)
              })
              const taskBinding = yield* captureRunTask({
                sql,
                itemId: origin.kind === RUN_ORIGIN.task ? origin.item_id : undefined
              }).pipe(
                Effect.mapError((cause) =>
                  storeError("claim", "invalid", cause.message, candidate.task_id, cause)
                )
              )
              const inserted = yield* sql<{ readonly id: number }>`
              INSERT INTO automation_runs (
                task_id, automation_ref, chat_run_id, chat_session_id,
                started_at, ended_at, status, result, error, origin, item_id, task_generation,
                purpose, handler, context_mode, trigger_json, input_json, claim_count,
                instruction_revision_id
              )
              VALUES (${candidate.task_id},
                     ${work.ref}, NULL, ${sessionId},
                     ${startedAt}, NULL, 'running', NULL, NULL, ${JSON.stringify(origin)},
                     ${taskBinding?.item_id ?? null}, ${taskBinding?.generation ?? null},
                     ${work.job.purpose}, ${work.handler}, ${work.contextMode}, ${triggerJson},
                     ${JSON.stringify(context.home_letter_input ?? context.space_review_input) ?? null}, 1,
                     ${work.instructionRevisionId})
              RETURNING id
            `
              automationRunId = inserted[0]?.id ?? null
              if (automationRunId === null) {
                return yield* storeError(
                  "claim",
                  "storage",
                  "Could not create Automation run",
                  candidate.task_id
                )
              }
              yield* skipRan(sql, context.from_skipped_run, candidate.task_id, automationRunId)
              context = { ...context, automation_run_id: automationRunId }
              const contextJson = yield* encodeQueueContext(context, "claim", candidate.task_id)
              yield* sql`
              UPDATE automation_event_queue
              SET context = ${contextJson}
              WHERE id = ${candidate.id} AND claimed_at = ${stamp}
            `
            } else {
              yield* sql`UPDATE automation_runs SET claim_count = claim_count + 1
                  WHERE id = ${automationRunId} AND status = 'running'`
              const running = yield* sql<{ readonly id: number }>`
              SELECT id FROM automation_runs
              WHERE id = ${automationRunId}
                AND task_id = ${candidate.task_id}
                AND status = 'running'
              LIMIT 1
            `
              if (running.length !== 1) {
                return yield* storeError(
                  "claim",
                  "corrupt",
                  "Automation job points to a missing run",
                  candidate.task_id
                )
              }
            }
            const run = yield* sql<{
              readonly chat_run_id: string | null
              readonly chat_session_id: string | null
              readonly context_mode: AutomationContextMode
              readonly authority: RunAuthorityState | null
              readonly claim_count: number
            }>`
            SELECT attempt.chat_run_id, attempt.chat_session_id, attempt.context_mode,
              attempt.claim_count,
              ${runAuthorityState(sql, sql`chat.metadata_json`, sql`chat.run_id`, sql`chat.session_id`)} AS authority
            FROM automation_runs AS attempt LEFT JOIN chat_runs AS chat ON chat.run_id = attempt.chat_run_id
            WHERE attempt.id = ${automationRunId} LIMIT 1
          `
            const runSnapshot = run[0]
            if (runSnapshot === undefined) {
              return yield* storeError(
                "claim",
                "corrupt",
                "Automation run snapshot is missing",
                candidate.task_id
              )
            }
            const handler = work.handler
            if (!isJobHandlerId(handler)) {
              const fenced = yield* loadFenced(
                {
                  id: String(candidate.id),
                  token: `${automationRunId}|${runSnapshot.claim_count}`
                },
                "claim",
                input.now
              )
              yield* settleFenced(fenced, input.now, "claim", {
                status: "ended",
                outcome: "failed",
                result: null,
                error: unknownHandlerMessage(handler),
                chatRunId: null,
                chatSessionId: null
              })
              continue
            }
            yield* sessionEvents.appendEventInTransaction({
              type: "automation_progress",
              task_id: candidate.task_id,
              status: "starting..."
            })
            const prompt = yield* claimedPrompt(
              owner,
              runSnapshot.context_mode,
              context.trigger_context
            )
            const targetContext = context.trigger_context_snapshot
            const target =
              targetContext?.source === AUTOMATION_OCCURRENCE.event &&
              targetContext.event_type === AUTOMATION_EVENT_TYPE.space_proposal_review_requested
                ? targetContext.context
                : undefined
            const proposalId = target?.proposal_id
            const expectedRevision = target?.expected_revision
            const proposalReviewTarget =
              typeof proposalId === "string" &&
              typeof expectedRevision === "number" &&
              Number.isInteger(expectedRevision) &&
              expectedRevision >= 0
                ? { proposalId, expectedRevision }
                : undefined
            leases.push({
              id: String(candidate.id),
              token: `${automationRunId}|${runSnapshot.claim_count}`,
              attempt: candidate.attempt_count + 1,
              payload: {
                ...work.jobOwner,
                purpose: bound?.purpose ?? work.job.purpose,
                name: work.name,
                automationRunId,
                sessionId,
                prompt,
                model: work.model,
                chatKind: work.chatKind,
                contextMode: runSnapshot.context_mode,
                chatRun: yield* readJobChatRun(runSnapshot, "claim", candidate.task_id),
                occurrence: candidate.source,
                ...(context.scheduled_for === null ? {} : { scheduledFor: context.scheduled_for }),
                triggeringChange: context.triggering_change ?? null,
                prefilter: jobPrefilter(context, input.now),
                ...(proposalReviewTarget === undefined ? {} : { proposalReviewTarget }),
                ...jobHandler(handler, context)
              },
              leasedAt: Date.parse(stamp),
              expiresAt: Date.parse(stamp) + input.leaseDurationMs
            })
          }
          return leases
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError("claim", "storage", "Could not claim Automation jobs", undefined, cause)
        )
      )
  })
  return { claimEffect, claimedPrompt }
}
