import { freshRow } from "./automation-enqueue.js"
import { isUserAutomationPurpose } from "../job-classification.js"
import { systemHandlerTellsOwner } from "../automations/model.js"
import { readAutomationFollowup } from "./automation-followup.js"
import { haltAutomation } from "./automation-halt.js"
import { recordTaskReport } from "./work-events.js"
import { answersSchedule, consumeIdleInput } from "./automation-occurrence.js"
import { quietRunOutcome } from "./run-outcomes.js"
import { recordAutomationEvent } from "./entity-events.js"
import { announceNotice } from "./notices.js"
import { recordEnding, toldOutcomeOf } from "./run-ending.js"
import { endAutoResumes, endStreak, pauseOnGivingUp } from "./automation-auto-pause.js"
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
  type QueueEntry,
  type WorkOwner,
  boundAttemptJson,
  storeError,
  decodeBoundAttempt,
  decodeOwner,
  decodeQueueContext,
  isDefinition,
  ownerJoin,
  ownerJson
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
      Pick<QueueEntry, "task_id" | "source" | "context"> & {
        readonly owner: string | null
        readonly bound: string
        readonly chat_run_id: string | null
        readonly chat_session_id: string | null
      }
    >`
      SELECT queue.task_id, queue.source, queue.context,
             ${ownerJson(sql)} AS owner, ${boundAttemptJson(sql, "run")} AS bound,
             run.chat_run_id, run.chat_session_id
      FROM automation_event_queue AS queue
      ${ownerJoin(sql)}
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
    return {
      parsed,
      queue: { task_id: row.task_id, source: row.source },
      pinned: { chatRunId: row.chat_run_id, chatSessionId: row.chat_session_id },
      bound: yield* decodeBoundAttempt(row, operation),
      owner: yield* decodeOwner(row, operation),
      context: yield* decodeQueueContext(row, operation)
    }
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
            runId: fenced.pinned.chatRunId,
            sessionId: fenced.pinned.chatSessionId
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
          fenced.queue.task_id
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
    const { purpose } = fenced.bound
    const taskItemId = purpose === "task_execution" ? fenced.bound.itemId : null
    const internalSpaceJob = isSpaceWorkJob(fenced.bound)
    const definition = isDefinition(fenced.owner) ? fenced.owner : undefined
    const automation = definition?.kind === "automation" ? definition : undefined
    const triggers =
      automation === undefined
        ? []
        : yield* decodeJson(AutomationTriggersSchema, automation.authored.triggers).pipe(
            Effect.mapError((cause) =>
              storeError(
                operation,
                "corrupt",
                "Stored Automation triggers are corrupt",
                fenced.queue.task_id,
                cause
              )
            )
          )
    const schedule =
      automation === undefined || (internalSpaceJob && triggers.length === 0)
        ? null
        : yield* scheduleEffect(rules, triggers, operation, fenced.queue.task_id)
    const wasEnabled = definition?.state.enabled === true
    let nextRunAt: string | null | undefined
    let enabled: number | undefined
    let spent = false
    if (answersSchedule(fenced.context, fenced.queue.source) && schedule !== null) {
      const oneShot = rules.oneShot(schedule)
      if (!wasEnabled || oneShot || schedule.times.length === 0) {
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
        yield* sql`DELETE FROM automation_event_queue WHERE task_id = ${fenced.queue.task_id}
          AND ${freshRow(sql)} AND source = 'scheduled'`
    }
    const done = jobDone({
      purpose,
      enabled: wasEnabled,
      outcome,
      followup: followup?.action,
      spent
    })
    yield* endAutomationRun(sql, run)
    if (enabled === 0)
      yield* haltAutomation({
        sql,
        sessionEvents,
        automationId: fenced.queue.task_id,
        halt: "stop",
        settlingRunId: settledRunId ?? undefined
      })
    const counted = ending.status !== "skipped"
    const lastResult = ran ? run.result : run.error
    if (definition !== undefined) {
      const { state } = definition
      yield* sql`
        UPDATE scheduled_tasks
        SET job_held_since = NULL,
            last_run_at = ${counted && ran ? endedAt : state.lastRunAt},
            last_result = ${counted ? lastResult : state.lastResult},
            next_run_at = ${nextRunAt === undefined ? state.nextRunAt : nextRunAt}
        WHERE task_id = ${definition.key}
      `
      if (counted && ran) {
        yield* endStreak(sql, definition.key)
        yield* endAutoResumes(sql, definition.key)
      }
    }
    const userAutomation = isUserAutomationPurpose(purpose)
    const endingRecord = yield* recordEnding(sql, {
      kind: "occurrence",
      purpose,
      run
    })
    const told = toldOutcomeOf(endingRecord, run)
    if (
      definition !== undefined &&
      userAutomation &&
      told !== undefined &&
      settledRunId === null &&
      outcome === "failed"
    ) {
      yield* recordAutomationEvent(sql, {
        sessionEvents,
        automationId: fenced.queue.task_id,
        attemptId: fenced.parsed.runId,
        event: "failed",
        text: told.text
      })
    }
    if (
      definition !== undefined &&
      told !== undefined &&
      (isUserAutomationPurpose(purpose) || purpose === "system")
    ) {
      yield* raiseRunEnded({
        sql,
        rules,
        dispatch: dispatchInTransaction,
        automationId: fenced.queue.task_id,
        purpose,
        attemptId: fenced.parsed.runId,
        outcome: told.outcome,
        text: told.text,
        sessionId: settledSessionId,
        context: fenced.context
      })
    }
    const paused =
      definition !== undefined &&
      outcome === "failed" &&
      (userAutomation ||
        (automation !== undefined && systemHandlerTellsOwner(automation.authored.handler)))
        ? yield* pauseOnGivingUp({
            sql,
            sessionEvents,
            automationId: fenced.queue.task_id,
            attemptId: fenced.parsed.runId,
            chatRunId: settledRunId
          })
        : false
    yield* sql`DELETE FROM automation_event_queue WHERE id = ${fenced.parsed.queueId}`
    if (fenced.owner?.kind === "space_review" && outcome === "failed")
      yield* spaceJobs.retryReview(fenced.queue.task_id, endedAt)
    yield* consumeIdleInput({ sql, automationId: fenced.queue.task_id, context: fenced.context })
    if (taskItemId !== null && outcome === "failed") {
      yield* spaceJobs.failTask(taskItemId, run.error, endedAt, settledRunId)
    }
    if (internalSpaceJob && settledRunId !== null)
      yield* recordTaskReport({ sql, sessionEvents }, settledRunId)
    if (taskItemId !== null && ran && settledRunId !== null) {
      yield* spaceJobs.keepMoving(taskItemId, settledRunId, endedAt)
    }
    if (
      schedule !== null &&
      !paused &&
      (enabled === undefined ? wasEnabled : enabled === 1) &&
      (schedule.idle !== null || schedule.count !== null)
    ) {
      yield* rearmAutomation(
        {
          automationId: fenced.queue.task_id,
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
        automationId: fenced.queue.task_id,
        settlingRunId: settledRunId ?? undefined
      })
    yield* announceEnded(sessionEvents, {
      automationId: fenced.queue.task_id,
      purpose,
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
  const releaseDefinitionHold = (owner: WorkOwner | undefined) =>
    isDefinition(owner)
      ? sql`UPDATE scheduled_tasks SET job_held_since = NULL WHERE task_id = ${owner.key}`.pipe(
          Effect.asVoid
        )
      : Effect.void
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
              hold_started_at = NULL,
              lease_expires_at = NULL,
              attempt_count = MAX(0, attempt_count - 1),
              last_error = NULL,
              next_attempt_at = ${nextAttemptAt}
          WHERE id = ${fenced.parsed.queueId}
        `
          yield* releaseDefinitionHold(fenced.owner)
          return {
            automationTaskId: fenced.queue.task_id,
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
          SET claimed_at = NULL, hold_started_at = NULL, lease_expires_at = NULL,
              last_error = ${input.error},
              next_attempt_at = ${iso(retryAt)}
          WHERE id = ${fenced.parsed.queueId}
        `
          yield* releaseDefinitionHold(fenced.owner)
          yield* sessionEvents.appendEventInTransaction({
            type: "automation_progress",
            task_id: fenced.queue.task_id,
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
        UPDATE automation_event_queue
        SET claimed_at = NULL, hold_started_at = NULL, lease_expires_at = NULL
        WHERE id = ${fenced.parsed.queueId}
      `
          yield* releaseDefinitionHold(fenced.owner)
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
