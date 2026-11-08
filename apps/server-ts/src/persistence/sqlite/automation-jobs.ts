import { cutText } from "@arden-hq/std/text"
import { triggerContextForClaim } from "./automation-occurrence.js"
import { isUserAutomationPurpose } from "../job-classification.js"
import { enqueue, holdForCooldown } from "./automation-enqueue.js"
import { dropClosedAsks } from "./automation-ask-feed.js"
import { parseLease } from "./automation-lease.js"
import { queueNextDueAt } from "./automation-next-due.js"
import type { QueueContext } from "./automation-queue-context.js"
import { reopenDeferredTasks } from "./work-lifecycle.js"
import {
  JobLeaseLostError,
  type JobClaimInput,
  type JobCompleteInput,
  type JobFailInput,
  type JobReleaseInput,
  type JobRenewInput
} from "@arden-hq/jobs"
import {
  captureRunTask,
  runAuthorityState,
  queueOccurrenceId,
  scheduledRunOrigin,
  type RunAuthorityState
} from "./run-context.js"
import { hasPendingTaskApproval, hasPendingTaskQuestion } from "./task-question-state.js"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import { batchAtClaim, jobPrefilter, withEventText } from "./automation-event-batch.js"
import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { Clock, Effect, Schema } from "effect"
import { wakeChainDepth } from "../automations/chain-depth.js"
import { AutomationId, SYSTEM_HANDLER_IDS } from "../automations/model.js"
import { AutomationQueue } from "../automations/queue.js"
import {
  AutomationStoreError,
  type AutomationJobHandler,
  type AutomationJobPayload,
  type ClaimedAutomationJobLease,
  type AutomationJobSettlement
} from "../automations/store.js"
import { namedPublicRef } from "../public-ref.js"
import type { AutomationJobPrompt } from "../automations/job-prompt.js"
import { isSpaceWorkJob, type JobPurpose } from "../job-classification.js"
import { encodeJson } from "./json.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { makeAutomationJobSettlement, makeFencedOccurrences } from "./automation-job-settlement.js"
import {
  type StoreOperation,
  type QueueRow,
  storeError,
  decodeQueueContext,
  encodeQueueContext
} from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import { activeRunStatusList } from "./status-sets.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { causingAutomation } from "./run-cause.js"
import { queuedEventType } from "./automation-listening.js"

const JobChatRunSchema = Schema.NullOr(
  Schema.Struct({
    runId: Schema.NonEmptyString,
    sessionId: Schema.NonEmptyString,
    authority: Schema.Literals(["active", "settling", "revoked"])
  })
)

const readJobChatRun = Effect.fn("AutomationJob.readChatRun")(function* (
  row:
    | {
        readonly chat_run_id: string | null
        readonly chat_session_id: string | null
        readonly authority: RunAuthorityState | null
      }
    | undefined,
  operation: StoreOperation,
  automationId: string
): Effect.fn.Return<AutomationJobPayload["chatRun"], AutomationStoreError> {
  if (!row)
    return yield* storeError(
      operation,
      "corrupt",
      "The Automation occurrence is missing",
      automationId
    )
  return yield* Schema.decodeUnknownEffect(JobChatRunSchema)(
    row.chat_run_id === null
      ? null
      : { runId: row.chat_run_id, sessionId: row.chat_session_id, authority: row.authority }
  ).pipe(
    Effect.mapError((cause) =>
      storeError(
        operation,
        "corrupt",
        "The Automation Run identity is incomplete",
        automationId,
        cause
      )
    )
  )
})

const JobHandlerIdSchema = Schema.NullOr(Schema.Literals(SYSTEM_HANDLER_IDS))

const isJobHandlerId = Schema.is(JobHandlerIdSchema)

const unknownHandlerMessage = (handler: string | null) => `Unknown Automation handler: ${handler}`

const readJobHandler = Effect.fn("AutomationJob.readHandler")(function* (
  handler: string | null,
  context: QueueContext,
  operation: StoreOperation,
  automationId: string
): Effect.fn.Return<AutomationJobHandler, AutomationStoreError> {
  if (!isJobHandlerId(handler))
    return yield* storeError(operation, "corrupt", unknownHandlerMessage(handler), automationId)
  return jobHandler(handler, context)
})

const jobHandler = (
  id: typeof JobHandlerIdSchema.Type,
  context: QueueContext
): AutomationJobHandler => {
  switch (id) {
    case null:
      return context.space_review_input === undefined
        ? { handler: id }
        : { handler: id, spaceReviewInput: context.space_review_input }
    case "home_letter":
      return context.home_letter_input === undefined
        ? { handler: id }
        : { handler: id, homeLetterInput: context.home_letter_input }
    case "memory_capture":
    case "daily_summary":
    case "wiki_maintenance":
      return context.handler_item === undefined
        ? { handler: id }
        : { handler: id, handlerItem: context.handler_item }
    case "managed_history_collection":
    case "chat_summaries":
      return { handler: id }
  }
}

const nextLeaseStamp = (epochMs: number, previous: string | null): string => {
  const previousMs = previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous)
  return iso(Math.max(epochMs, Number.isFinite(previousMs) ? previousMs + 1 : epochMs))
}

export const makeAutomationJobs = ({
  writer,
  sessionEvents,
  rules,
  diagnostics
}: Pick<
  AutomationStoreDeps,
  "writer" | "sessionEvents" | "rules" | "diagnostics"
>): AutomationQueue["Service"]["jobs"] => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const { loadFenced, settleFenced } = makeFencedOccurrences({ writer, sessionEvents, rules })
  const { completeEffect, failEffect, releaseEffect } = makeAutomationJobSettlement({
    writer,
    sessionEvents,
    rules,
    diagnostics
  })
  const claimedPrompt = Effect.fn("SqliteAutomationStore.claimedPrompt")(function* (
    job: {
      readonly task_id: string
      readonly purpose: JobPurpose
      readonly prompt: string
      readonly context_mode: AutomationContextMode
    },
    triggerContext: string | undefined
  ) {
    const context = isSpaceWorkJob(job) ? yield* spaceJobs.context(job.task_id) : undefined
    if (context !== undefined)
      return { kind: "space_job", context, triggerContext } satisfies AutomationJobPrompt
    if (job.context_mode !== "fresh")
      return { kind: "text", text: job.prompt, triggerContext } satisfies AutomationJobPrompt
    const cards = yield* sql<{
      readonly count: number
      readonly run_id: string
      readonly tool_call_id: string
      readonly tool_name: string
      readonly preview: string | null
      readonly arguments_json: string
    }>`
      SELECT COUNT(*) OVER () AS count, card.run_id, card.tool_call_id,
        card.tool_name, card.preview, call.arguments_json
      FROM (${pendingDecisionCards(sql)}) AS card
      JOIN chat_runs AS run ON run.run_id = card.run_id
      JOIN tool_calls AS call ON call.run_id = card.run_id
        AND call.tool_call_id = card.tool_call_id
      WHERE ${causingAutomation(sql, "run")} = ${job.task_id}
      ORDER BY card.requested_at, card.run_id, card.tool_call_id
      LIMIT 32
    `
    const pendingContext =
      cards.length === 0
        ? ""
        : `\n\nExisting requests waiting for the user's decision (${cards[0]?.count ?? cards.length} total). These cards are context, not permission. Refer to an existing card by its exact run and call IDs; do not repeat its pending action.\n${cards
            .map(
              (card) =>
                `- run ${card.run_id}, call ${card.tool_call_id}, tool ${card.tool_name}, preview ${JSON.stringify(card.preview)}, arguments ${cutText(card.arguments_json, 2_048, { suffix: " [arguments truncated]" })}`
            )
            .join(
              "\n"
            )}${cards[0] !== undefined && cards[0].count > cards.length ? "\nMore pending cards remain unresolved." : ""}`
    return {
      kind: "text",
      text: `${job.prompt}${pendingContext}`,
      triggerContext
    } satisfies AutomationJobPrompt
  })

  const materializeDue = Effect.fn("SqliteAutomationStore.materializeDue")(function* (now: string) {
    const due = yield* sql<{ readonly task_id: string; readonly next_run_at: string }>`
      SELECT task_id, next_run_at
      FROM scheduled_tasks AS task
      WHERE enabled = 1
        AND next_run_at IS NOT NULL
        AND next_run_at <= ${now}
        AND running_since IS NULL
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
            yield* spaceJobs.queueTaskWake(task.item_id, nowText)
          yield* materializeDue(nowText)
          yield* spaceJobs.materializeDue(nowText)
          yield* dropClosedAsks(sql, nowText)
          const leases: Array<ClaimedAutomationJobLease> = []
          while (leases.length < input.limit) {
            const candidates = yield* sql<
              QueueRow & {
                readonly cooldown_minutes: number | null
                readonly admitted_run_id: number | null
              }
            >`
            SELECT queue.id, queue.task_id, queue.source, queue.context, queue.created_at,
                   queue.claimed_at, queue.lease_expires_at, queue.attempt_count, queue.next_attempt_at,
                   task.name, task.prompt, task.model, task.context_mode, task.thread_id, task.handler, task.purpose, task.owner_space_id, task.owner_task_id, task.enabled,
                   run_chat.origin_automation_id AS run_chat_origin_automation_id,
                   task.running_since, task.cooldown_minutes,
                   task.next_run_at AS task_next_run_at,
                   task.last_run_at AS task_last_run_at, admitted.id AS admitted_run_id
            FROM automation_event_queue AS queue
            JOIN scheduled_tasks AS task ON task.task_id = queue.task_id
            LEFT JOIN sessions AS run_chat ON run_chat.session_id = task.thread_id
            LEFT JOIN automation_runs AS admitted
              ON admitted.id = json_extract(queue.context, '$.automation_run_id')
                AND admitted.task_id = queue.task_id
            WHERE (queue.next_attempt_at IS NULL OR queue.next_attempt_at <= ${nowText})
              AND (task.purpose != 'task_execution' OR admitted.chat_run_id IS NOT NULL
                OR json_extract(queue.context, '$.person_change_at') IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM space_tasks AS owner
                  WHERE owner.item_id = task.owner_task_id AND owner.next_attempt_at > ${nowText}))
              -- A Task moved to the background during its step in a chat goes on
              -- from where that step ends, not beside it.
              AND (task.purpose != 'task_execution' OR admitted.chat_run_id IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM chat_runs AS step
                  WHERE json_extract(step.metadata_json, '$.run_context.task.item_id') = task.owner_task_id
                    AND json_extract(step.metadata_json, '$.run_context.origin.kind') = 'chat'
                    AND json_extract(step.metadata_json, '$.run_context.origin.session_id') =
                      (SELECT home_session_id FROM space_tasks WHERE item_id = task.owner_task_id)
                    AND step.status IN ${activeRunStatusList}))
              AND (
                queue.source != 'event'
                OR ${queuedEventType(sql, sql`queue.context`)} != 'wiki.changed'
                OR json_extract(queue.context, '$.trigger_context_snapshot.produced_by') IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM automation_runs AS producer
                  WHERE producer.task_id = json_extract(queue.context, '$.trigger_context_snapshot.produced_by')
                    AND producer.status = 'running'
                )
              )
              AND (task.purpose != 'space_review' OR NOT EXISTS (
                SELECT 1 FROM automation_event_queue AS earlier
                JOIN automation_runs AS waiting ON waiting.id = json_extract(earlier.context, '$.automation_run_id')
                  AND waiting.task_id = earlier.task_id AND waiting.status = 'running'
                WHERE earlier.task_id = queue.task_id AND earlier.id != queue.id
                  AND (earlier.created_at < queue.created_at OR (earlier.created_at = queue.created_at AND earlier.id < queue.id))
              ))
              AND (task.purpose != 'task_execution' OR NOT ${hasPendingTaskQuestion(sql, sql`task.owner_task_id`)}
                OR admitted.chat_run_id IS NOT NULL
                OR (json_extract(queue.context, '$.person_change_at') IS NOT NULL
                  AND NOT ${hasPendingTaskApproval(sql, sql`task.owner_task_id`)}))
              AND (
                (queue.claimed_at IS NULL AND task.running_since IS NULL)
                OR
                (queue.claimed_at IS NOT NULL AND queue.lease_expires_at <= ${nowText}
                  AND task.running_since IS NOT NULL)
              )
              -- An Automation that is off runs nothing new, a run you asked for by
              -- hand included: it waits for the resume (automation-halt.ts).
              AND (task.enabled = 1 OR admitted.chat_run_id IS NOT NULL)
              -- A user's Automation waits for its own chat to be free. A run that
              -- reads one of your chats works in a copy of it, so nothing waits.
              AND (
                task.purpose != 'user_automation'
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
            if (candidate.thread_id === null && candidate.handler === null) {
              return yield* storeError(
                "claim",
                "corrupt",
                "Automation has no Chat session",
                candidate.task_id
              )
            }
            let sessionId = candidate.thread_id
            if (sessionId !== null) {
              const live = yield* sql<{ readonly session_id: string }>`
              SELECT session_id FROM sessions
              WHERE session_id = ${sessionId} AND archived_at IS NULL
              LIMIT 1
            `
              if (live.length === 0) {
                const spaceId = candidate.owner_space_id
                const threadId = yield* nextId
                sessionId = threadId
                yield* insertSession({
                  sql,
                  session: {
                    type: "channel",
                    sessionId: threadId,
                    publicRef: namedPublicRef(candidate.name, threadId),
                    startedAt: nowText,
                    name: candidate.name,
                    metadata: "{}",
                    spaceId,
                    chatModel: candidate.model,
                    originAutomationId: candidate.task_id
                  },
                  lifecycle: {
                    kind: "announce",
                    events: sessionEvents,
                    complete: sql`
                  UPDATE scheduled_tasks SET thread_id = ${threadId}
                  WHERE task_id = ${candidate.task_id}
                `
                  }
                })
              }
            }
            let context = yield* decodeQueueContext(candidate, "claim")
            if (context.automation_run_id === null) {
              context = yield* batchAtClaim({ sql, row: candidate, context, now: nowText })
              if (candidate.source === "event" || candidate.source === "manual")
                context = withEventText(context, input.now, candidate.cooldown_minutes)
            }
            const stamp = nextLeaseStamp(input.now, candidate.claimed_at)
            const startedAt = candidate.running_since ?? nowText
            yield* sql`
            UPDATE automation_event_queue
            SET claimed_at = ${stamp}, lease_expires_at = ${iso(Date.parse(stamp) + input.leaseDurationMs)}, attempt_count = attempt_count + 1,
                last_error = NULL
            WHERE id = ${candidate.id}
              AND claimed_at IS ${candidate.claimed_at}
          `
            yield* sql`
            UPDATE scheduled_tasks
            SET running_since = ${startedAt}
            WHERE task_id = ${candidate.task_id}
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
                job: candidate,
                automationId: candidate.task_id,
                occurrenceId: queueOccurrenceId(candidate),
                chainDepth: wakeChainDepth(trigger)
              })
              const taskBinding = yield* captureRunTask({
                sql,
                itemId: origin.kind === "task" ? origin.item_id : undefined
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
              SELECT task_id, automation_ref, NULL, ${sessionId},
                     ${startedAt}, NULL, 'running', NULL, NULL, ${JSON.stringify(origin)},
                     ${taskBinding?.item_id ?? null}, ${taskBinding?.generation ?? null},
                     purpose, handler, ${runContextMode(candidate)}, ${triggerJson},
                     ${JSON.stringify(context.home_letter_input ?? context.space_review_input) ?? null}, 1,
                     instruction_revision_id
              FROM scheduled_tasks
              WHERE task_id = ${candidate.task_id}
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
              if (context.from_skipped_run !== undefined) {
                yield* sql`UPDATE automation_runs
                  SET skip_json = json_set(skip_json, '$.ran.run_id', ${automationRunId})
                  WHERE id = ${context.from_skipped_run} AND task_id = ${candidate.task_id}
                    AND json_type(skip_json, '$.ran') = 'object'`
              }
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
              ${runAuthorityState(sql, sql`chat.metadata_json`, sql`chat.run_id`)} AS authority
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
            const handler = candidate.handler
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
            const prompt = yield* claimedPrompt(candidate, context.trigger_context)
            const targetContext = context.trigger_context_snapshot
            const target =
              targetContext?.source === "event" &&
              targetContext.event_type === "space.proposal_review_requested"
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
                automationId: AutomationId.make(candidate.task_id),
                purpose: candidate.purpose,
                name: candidate.name,
                automationRunId,
                sessionId,
                prompt,
                model: candidate.model,
                chatKind: chatKindOf(candidate),
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

  const recoverExpiredEffect = Effect.fn("SqliteAutomationStore.recoverExpired")(function* () {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const released = yield* sql<{ readonly id: number }>`
        UPDATE automation_event_queue
        SET claimed_at = NULL, lease_expires_at = NULL
        WHERE claimed_at IS NOT NULL
          AND task_id IN (
            SELECT task_id FROM scheduled_tasks WHERE running_since IS NULL
          )
        RETURNING id
      `
          const cleared = yield* sql<{ readonly task_id: string }>`
        UPDATE scheduled_tasks
        SET running_since = NULL
        WHERE running_since IS NOT NULL
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
          const rows = yield* sql<QueueRow>`
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
      RETURNING id, task_id, source, context, created_at, claimed_at, lease_expires_at, attempt_count,
                next_attempt_at,
                (SELECT prompt FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS prompt,
                (SELECT name FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS name,
                (SELECT model FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS model,
                (SELECT context_mode FROM automation_runs WHERE id = ${parsed.runId}) AS context_mode,
                (SELECT chat.origin_automation_id FROM scheduled_tasks AS task
                 LEFT JOIN sessions AS chat ON chat.session_id = task.thread_id
                 WHERE task.task_id = automation_event_queue.task_id) AS run_chat_origin_automation_id,
                (SELECT thread_id FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS thread_id,
                (SELECT handler FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS handler,
                (SELECT purpose FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS purpose,
                (SELECT owner_space_id FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS owner_space_id,
                (SELECT owner_task_id FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS owner_task_id,
                (SELECT enabled FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS enabled,
                (SELECT running_since FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS running_since,
                (SELECT next_run_at FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS task_next_run_at,
                (SELECT last_run_at FROM scheduled_tasks WHERE task_id = automation_event_queue.task_id) AS task_last_run_at
    `.pipe(
            Effect.mapError((cause) =>
              storeError("renew", "storage", "Could not renew Automation job", undefined, cause)
            )
          )
          const row = rows[0]
          if (
            row === undefined ||
            row.claimed_at === null ||
            row.lease_expires_at === null ||
            (row.thread_id === null && row.handler === null)
          ) {
            throw new JobLeaseLostError(input.id)
          }
          const context = yield* decodeQueueContext(row, "renew")
          const run = yield* sql<{
            readonly chat_run_id: string | null
            readonly chat_session_id: string | null
            readonly context_mode: AutomationContextMode
            readonly authority: RunAuthorityState | null
          }>`
      SELECT attempt.chat_run_id, attempt.chat_session_id, attempt.context_mode,
        ${runAuthorityState(sql, sql`chat.metadata_json`, sql`chat.run_id`)} AS authority
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
          const prompt = yield* claimedPrompt(row, context.trigger_context)
          return {
            id: input.id,
            token: input.token,
            attempt: row.attempt_count,
            payload: {
              automationId: AutomationId.make(row.task_id),
              purpose: row.purpose,
              name: row.name,
              automationRunId: parsed.runId,
              sessionId: row.thread_id,
              prompt,
              model: row.model,
              chatKind: chatKindOf(row),
              contextMode: run[0].context_mode,
              chatRun: yield* readJobChatRun(run[0], "renew", row.task_id),
              occurrence: row.source,
              ...(context.scheduled_for === null ? {} : { scheduledFor: context.scheduled_for }),
              triggeringChange: context.triggering_change ?? null,
              prefilter: jobPrefilter(context, Date.parse(row.claimed_at)),
              ...(yield* readJobHandler(row.handler, context, "renew", row.task_id))
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

const chatKindOf = (
  row: Pick<QueueRow, "purpose" | "task_id" | "run_chat_origin_automation_id">
): "own" | "yours" =>
  isUserAutomationPurpose(row.purpose) && row.run_chat_origin_automation_id !== row.task_id
    ? "yours"
    : "own"

const runContextMode = (
  row: Pick<QueueRow, "purpose" | "task_id" | "run_chat_origin_automation_id" | "context_mode">
): AutomationContextMode =>
  chatKindOf(row) === "yours" && row.context_mode === "continue" ? "fork" : row.context_mode
