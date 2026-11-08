import { freshRow } from "./automation-enqueue.js"
import { isUserAutomationPurpose } from "../job-classification.js"
import { readAutomationFollowup } from "./automation-followup.js"
import { haltAutomation } from "./automation-halt.js"
import { recordTaskReport } from "./work-events.js"
import { answersSchedule, consumeIdleInput } from "./automation-occurrence.js"
import { quietRunOutcome } from "./run-outcomes.js"
import { recordAutomationEvent } from "./entity-events.js"
import { announceNotice } from "./notices.js"
import { recordEnding, toldOutcomeOf } from "./run-ending.js"
import { pauseAfterFailures } from "./automation-auto-pause.js"
import { parseLease } from "./automation-lease.js"
import {
  JobLeaseLostError,
  type JobCompleteInput,
  type JobFailInput,
  type JobReleaseInput
} from "@arden-hq/jobs"
import { Effect } from "effect"
import {
  AutomationStoreError,
  type AutomationJobDeferral,
  type AutomationJobOutcome,
  type AutomationJobResult,
  type AutomationJobSettlement,
  type AutomationJobSkip
} from "../automations/store.js"
import { isSpaceWorkJob, type JobPurpose } from "../job-classification.js"
import { ranOutcome, type AutomationRunOutcome } from "@arden-hq/protocol/automations"
import { deleteAutomationRow } from "./automation-removal.js"
import { decodeJson } from "./json.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { AutomationTriggersSchema, scheduleEffect } from "./automation-schedule.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { makeTriggerArming } from "./automation-trigger-arming.js"
import { makeAutomationEventDispatch } from "./automation-event-dispatch.js"
import { raiseRunEnded } from "./automation-run-ended.js"
import {
  type StoreOperation,
  type QueueRow,
  storeError,
  decodeQueueContext
} from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import { activeRunStatusList } from "./status-sets.js"
import { skipEnd } from "./automation-skip-record.js"
import { hasOpenRunAsks } from "./run-asks.js"
import {
  announceEnded,
  endAutomationRun,
  type EndedAutomationRun
} from "./automation-run-outcome.js"

const AUTOMATION_DEFERRAL_MIN_MS = 1_000

const AUTOMATION_DEFERRAL_MAX_MS = 30_000

const PLAN_LIMIT_RECHECK_MS = 15 * 60_000

const longestDeferral = (cause: AutomationJobDeferral["cause"]): number => {
  switch (cause) {
    case "session_busy":
    case "no_model":
      return AUTOMATION_DEFERRAL_MAX_MS
    case "plan_limit":
      return PLAN_LIMIT_RECHECK_MS
  }
}

export const makeFencedOccurrences = ({
  writer,
  sessionEvents,
  rules
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules">) => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const { rearmAutomation } = makeTriggerArming({ writer, sessionEvents })
  const { dispatchInTransaction } = makeAutomationEventDispatch({ writer, sessionEvents, rules })
  const loadFenced = Effect.fn("SqliteAutomationStore.loadFenced")(function* (
    input: { readonly id: string; readonly token: string },
    operation: StoreOperation,
    now: number
  ) {
    const parsed = parseLease(input)
    const rows = yield* sql<
      QueueRow & {
        readonly triggers: string
        readonly task_last_result: string | null
        readonly cooldown_minutes: number | null
        readonly automation_run_status: string
        readonly automation_chat_run_id: string | null
        readonly automation_chat_session_id: string | null
      }
    >`
      SELECT queue.id, queue.task_id, queue.source, queue.context, queue.created_at,
             queue.claimed_at, queue.lease_expires_at, queue.attempt_count, queue.next_attempt_at,
             task.prompt, task.model, task.context_mode, task.thread_id, task.handler, task.purpose, task.owner_space_id, task.owner_task_id,
             task.enabled, task.running_since,
             task.next_run_at AS task_next_run_at,
             task.last_run_at AS task_last_run_at, task.last_result AS task_last_result, task.triggers,
             task.cooldown_minutes,
             run.status AS automation_run_status,
             run.chat_run_id AS automation_chat_run_id,
             run.chat_session_id AS automation_chat_session_id
      FROM automation_event_queue AS queue
      JOIN scheduled_tasks AS task ON task.task_id = queue.task_id
      JOIN automation_runs AS run ON run.id = ${parsed.runId}
      WHERE queue.id = ${parsed.queueId} AND queue.lease_expires_at > ${iso(now)}
        AND queue.claimed_at IS NOT NULL
        AND run.task_id = queue.task_id
        AND run.status = 'running'
        AND run.claim_count = ${parsed.claimAttempt}
        AND json_extract(queue.context, '$.automation_run_id') = ${parsed.runId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(operation, "storage", "Could not read fenced Automation job", undefined, cause)
      )
    )
    const row = rows[0]
    if (row === undefined) throw new JobLeaseLostError(input.id)
    return { parsed, row, context: yield* decodeQueueContext(row, operation) }
  })

  const settleFenced = Effect.fn("SqliteAutomationStore.settleFenced")(function* (
    fenced: Effect.Success<ReturnType<typeof loadFenced>>,
    settledAt: number,
    operation: "complete" | "fail" | "claim",
    ending: AutomationJobResult | AutomationJobSkip
  ) {
    const settled =
      ending.status === "ended" && ending.chatRunId !== null
        ? { runId: ending.chatRunId, sessionId: ending.chatSessionId }
        : {
            runId: fenced.row.automation_chat_run_id,
            sessionId: fenced.row.automation_chat_session_id
          }
    const settledRunId = settled.runId
    const settledSessionId = settled.sessionId
    if (operation === "complete" && settledRunId !== null) {
      const owned = yield* sql`SELECT 1 FROM chat_runs AS chat
              JOIN automation_runs AS attempt ON attempt.id = ${fenced.parsed.runId}
              WHERE chat.run_id = ${settledRunId} AND chat.session_id = ${settledSessionId}
                AND chat.status NOT IN ${activeRunStatusList}
                AND json_extract(chat.metadata_json, '$.run_context.origin') = json(attempt.origin)`
      if (owned.length !== 1)
        return yield* storeError(
          operation,
          "conflict",
          "Automation completion requires a terminal Run from this occurrence and its exact Session",
          fenced.row.task_id
        )
    }
    const endedAt = iso(settledAt)
    const identity = {
      id: fenced.parsed.runId,
      endedAt,
      chatRunId: settledRunId,
      chatSessionId: settledSessionId
    }
    const run: EndedAutomationRun =
      ending.status === "skipped"
        ? { ...identity, ...skipEnd(ending.skip), error: null, skip: ending.skip }
        : {
            ...identity,
            outcome: yield* settledOutcome(fenced.parsed.runId, ending),
            result: ending.result,
            error: ending.error,
            skip: null
          }
    const { outcome } = run
    const ran = ranOutcome(outcome)
    const triggers = yield* decodeJson(AutomationTriggersSchema, fenced.row.triggers).pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "corrupt",
          "Stored Automation triggers are corrupt",
          fenced.row.task_id,
          cause
        )
      )
    )
    const internalSpaceJob = isSpaceWorkJob(fenced.row)
    const schedule =
      internalSpaceJob && triggers.length === 0
        ? null
        : yield* scheduleEffect(rules, triggers, operation, fenced.row.task_id)
    let nextRunAt: string | null | undefined
    let enabled: number | undefined
    let spent = false
    if (answersSchedule(fenced.context, fenced.row.source) && schedule !== null) {
      const oneShot = rules.oneShot(schedule)
      if (fenced.row.enabled !== 1 || oneShot || schedule.times.length === 0) {
        nextRunAt = null
        if (oneShot) enabled = 0
        spent =
          oneShot &&
          triggers.length === schedule.times.length &&
          rules.nextRunAt(
            { times: schedule.times.filter((time) => time.kind === "once") },
            settledAt
          ) === null
      } else {
        const next = rules.nextRunAt(schedule, settledAt)
        nextRunAt = next === null ? null : iso(next)
      }
    }
    const followup = ran
      ? yield* readAutomationFollowup(sql, fenced.parsed.runId, settledRunId)
      : undefined
    if (followup !== undefined) {
      enabled = followup.action === "stop" ? 0 : undefined
      nextRunAt = followup.action === "stop" ? null : followup.at
      if (followup.action !== "stop")
        yield* sql`DELETE FROM automation_event_queue WHERE task_id = ${fenced.row.task_id}
          AND ${freshRow(sql)} AND source = 'scheduled'`
    }
    const done = jobDone({
      purpose: fenced.row.purpose,
      enabled: fenced.row.enabled === 1,
      outcome,
      followup: followup?.action,
      spent
    })
    yield* endAutomationRun(sql, run)
    if (enabled === 0)
      yield* haltAutomation({
        sql,
        sessionEvents,
        automationId: fenced.row.task_id,
        halt: "stop",
        settlingRunId: settledRunId ?? undefined
      })
    const counted = ending.status !== "skipped"
    const lastResult = ran ? run.result : run.error
    yield* sql`
        UPDATE scheduled_tasks
        SET running_since = NULL,
            last_run_at = ${counted && ran ? endedAt : fenced.row.task_last_run_at},
            last_result = ${counted ? lastResult : fenced.row.task_last_result},
            next_run_at = ${nextRunAt === undefined ? fenced.row.task_next_run_at : nextRunAt}
        WHERE task_id = ${fenced.row.task_id}
      `
    const userAutomation = isUserAutomationPurpose(fenced.row.purpose)
    const endingRecord = yield* recordEnding(sql, {
      kind: "occurrence",
      purpose: fenced.row.purpose,
      run
    })
    const told = toldOutcomeOf(endingRecord, run)
    if (userAutomation && told !== undefined && settledRunId === null && outcome === "failed") {
      yield* recordAutomationEvent(sql, {
        sessionEvents,
        automationId: fenced.row.task_id,
        attemptId: fenced.parsed.runId,
        event: "failed",
        text: told.text
      })
    }
    if (
      told !== undefined &&
      (isUserAutomationPurpose(fenced.row.purpose) || fenced.row.purpose === "system")
    ) {
      yield* raiseRunEnded({
        sql,
        rules,
        dispatch: dispatchInTransaction,
        automationId: fenced.row.task_id,
        purpose: fenced.row.purpose,
        attemptId: fenced.parsed.runId,
        outcome: told.outcome,
        text: told.text,
        sessionId: settledSessionId,
        context: fenced.context
      })
    }
    const paused =
      userAutomation && outcome === "failed"
        ? yield* pauseAfterFailures({
            sql,
            sessionEvents,
            automationId: fenced.row.task_id,
            attemptId: fenced.parsed.runId
          })
        : false
    yield* sql`DELETE FROM automation_event_queue WHERE id = ${fenced.parsed.queueId}`
    if (fenced.row.purpose === "space_review" && outcome === "failed")
      yield* spaceJobs.retryReview(fenced.row.task_id, endedAt)
    yield* consumeIdleInput({ sql, automationId: fenced.row.task_id, context: fenced.context })
    if (internalSpaceJob && outcome === "failed") {
      yield* spaceJobs.failTask(fenced.row.task_id, run.error, endedAt, settledRunId)
    }
    if (internalSpaceJob && settledRunId !== null)
      yield* recordTaskReport({ sql, sessionEvents }, settledRunId)
    if (internalSpaceJob && ran && settledRunId !== null) {
      yield* spaceJobs.keepMoving(fenced.row.task_id, settledRunId, endedAt)
    }
    if (
      schedule !== null &&
      !paused &&
      (enabled ?? fenced.row.enabled) === 1 &&
      (schedule.idle !== null || schedule.count !== null)
    ) {
      yield* rearmAutomation(
        {
          automationId: fenced.row.task_id,
          idle: schedule.idle?.idle_minutes ?? null,
          count: schedule.count?.every_n ?? null,
          chatQuiet: null
        },
        settledAt
      )
    }
    if (done && (settledRunId === null || !(yield* hasOpenRunAsks(sql, settledRunId))))
      yield* deleteAutomationRow({
        sql,
        sessionEvents,
        automationId: fenced.row.task_id,
        settlingRunId: settledRunId ?? undefined
      })
    yield* announceEnded(sessionEvents, {
      automationId: fenced.row.task_id,
      purpose: fenced.row.purpose,
      run
    })
    if (settledRunId !== null) yield* announceNotice(sql, sessionEvents, `ending:${settledRunId}`)
  })

  const settledOutcome = Effect.fn("SqliteAutomationStore.settledOutcome")(function* (
    attemptId: number,
    ending: AutomationJobResult
  ) {
    const admitted = yield* sql<{ readonly count: number; readonly quiet: number }>`
            SELECT COUNT(*) AS count, COALESCE(MIN(chat.status = 'completed' AND ${quietRunOutcome(sql, "chat")}), 0) AS quiet
            FROM chat_runs AS chat JOIN automation_runs AS attempt ON attempt.id = ${attemptId}
            WHERE json_extract(chat.metadata_json, '$.run_context.origin') = json(attempt.origin)`
    const ranModel = (admitted[0]?.count ?? 0) > 0
    const declared = noInput(ending.outcome, ranModel)
    return declared === "finished" && ranModel && admitted[0]?.quiet === 1 ? "no_change" : declared
  })

  return { loadFenced, settleFenced }
}

const jobDone = (input: {
  readonly purpose: JobPurpose
  readonly enabled: boolean
  readonly outcome: AutomationRunOutcome
  readonly followup: string | undefined
  readonly spent: boolean
}): boolean =>
  isUserAutomationPurpose(input.purpose) &&
  input.enabled &&
  (input.outcome === "finished" || input.outcome === "no_change") &&
  (input.followup === "stop" || (input.followup === undefined && input.spent))

const noInput = (
  outcome: AutomationJobOutcome,
  ranModel: boolean
): Exclude<AutomationJobOutcome, "no_input"> => {
  if (outcome !== "no_input") return outcome
  return ranModel ? "finished" : "no_change"
}

export const makeAutomationJobSettlement = ({
  writer,
  sessionEvents,
  rules,
  diagnostics
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules" | "diagnostics">) => {
  const sql = writer.sql
  const { loadFenced, settleFenced } = makeFencedOccurrences({ writer, sessionEvents, rules })
  const settle = Effect.fn("SqliteAutomationStore.settle")(function* (
    input: { readonly id: string; readonly token: string },
    settledAt: number,
    operation: "complete" | "fail",
    ending: AutomationJobResult | AutomationJobSkip
  ) {
    yield* writer
      .transact(
        Effect.gen(function* () {
          const fenced = yield* loadFenced(input, operation, settledAt)
          yield* settleFenced(fenced, settledAt, operation, ending)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError || cause instanceof JobLeaseLostError
            ? cause
            : storeError(operation, "storage", "Could not settle Automation job", undefined, cause)
        )
      )
  })

  const deferEffect = Effect.fn("SqliteAutomationStore.defer")(function* (
    input: JobCompleteInput<AutomationJobDeferral>
  ) {
    const deferred = yield* writer
      .transact(
        Effect.gen(function* () {
          const fenced = yield* loadFenced(input, "defer", input.completedAt)
          const requestedRetryAt = Number.isFinite(input.result.retryAt)
            ? input.result.retryAt
            : input.completedAt + AUTOMATION_DEFERRAL_MIN_MS
          const longest = longestDeferral(input.result.cause)
          const nextAttemptAt = iso(
            Math.min(
              input.completedAt + longest,
              Math.max(input.completedAt + AUTOMATION_DEFERRAL_MIN_MS, requestedRetryAt)
            )
          )
          yield* sql`
          UPDATE automation_event_queue
          SET claimed_at = NULL,
              lease_expires_at = NULL,
              attempt_count = MAX(0, attempt_count - 1),
              last_error = NULL,
              next_attempt_at = ${nextAttemptAt}
          WHERE id = ${fenced.parsed.queueId}
        `
          yield* sql`
          UPDATE scheduled_tasks SET running_since = NULL
          WHERE task_id = ${fenced.row.task_id}
        `
          return {
            automationTaskId: fenced.row.task_id,
            automationRunId: fenced.parsed.runId,
            queueId: fenced.parsed.queueId,
            nextAttemptAt
          }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError || cause instanceof JobLeaseLostError
            ? cause
            : storeError("defer", "storage", "Could not defer Automation firing", undefined, cause)
        )
      )
    yield* diagnostics.operational({
      code: "automation.firing_deferred",
      severity: "info",
      cause: input.result.reason,
      ...deferred,
      sessionId: input.result.sessionId
    })
  })

  const completeEffect = (input: JobCompleteInput<AutomationJobSettlement>) => {
    const result = input.result
    switch (result.status) {
      case "deferred":
        return deferEffect({ ...input, result })
      case "skipped":
      case "ended":
        return settle(input, input.completedAt, "complete", result)
    }
  }

  const failEffect = Effect.fn("SqliteAutomationStore.fail")(function* (input: JobFailInput) {
    const retryAt = input.retryAt
    if (retryAt === null) {
      return yield* settle(input, input.failedAt, "fail", {
        status: "ended",
        outcome: "failed",
        result: null,
        error: input.error,
        chatRunId: null,
        chatSessionId: null
      })
    }
    yield* writer
      .transact(
        Effect.gen(function* () {
          const fenced = yield* loadFenced(input, "fail", input.failedAt)
          yield* sql`
          UPDATE automation_event_queue
          SET claimed_at = NULL, lease_expires_at = NULL, last_error = ${input.error},
              next_attempt_at = ${iso(retryAt)}
          WHERE id = ${fenced.parsed.queueId}
        `
          yield* sql`
          UPDATE scheduled_tasks SET running_since = NULL
          WHERE task_id = ${fenced.row.task_id}
        `
          yield* sessionEvents.appendEventInTransaction({
            type: "automation_progress",
            task_id: fenced.row.task_id,
            status: "retrying"
          })
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError || cause instanceof JobLeaseLostError
            ? cause
            : storeError("fail", "storage", "Could not retry Automation job", undefined, cause)
        )
      )
  })

  const releaseEffect = Effect.fn("SqliteAutomationStore.release")(function* (
    input: JobReleaseInput
  ) {
    yield* writer
      .transact(
        Effect.gen(function* () {
          const fenced = yield* loadFenced(input, "release", input.releasedAt)
          yield* sql`
        UPDATE automation_event_queue SET claimed_at = NULL, lease_expires_at = NULL
        WHERE id = ${fenced.parsed.queueId}
      `
          yield* sql`
        UPDATE scheduled_tasks SET running_since = NULL
        WHERE task_id = ${fenced.row.task_id}
      `
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError || cause instanceof JobLeaseLostError
            ? cause
            : storeError("release", "storage", "Could not release Automation job", undefined, cause)
        )
      )
  })

  return { completeEffect, failEffect, releaseEffect }
}
