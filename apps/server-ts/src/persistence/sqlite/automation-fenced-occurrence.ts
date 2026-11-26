import { freshRow } from "./automation-enqueue.js"
import {
  AUTOMATION_FOLLOWUP,
  HANDLER_TOOL_NAMES,
  type AutomationFollowup
} from "../automations/queue.js"
import { JOB_SUBJECT_KIND } from "../space-job-id.js"
import { isUserAutomationPurpose, isSpaceWorkJob, type JobPurpose } from "../job-classification.js"
import { readAutomationFollowup } from "./automation-followup.js"
import { haltAutomation } from "./automation-halt.js"
import { recordTaskReport } from "./work-events.js"
import { answersSchedule, consumeIdleInput } from "./automation-occurrence.js"
import { quietRunOutcome } from "./run-outcomes.js"
import { recordAutomationEvent } from "./entity-events.js"
import { announceNotice } from "./notices.js"
import { recordEnding } from "./run-ending.js"
import { toldOutcomeOf } from "./run-ending-said.js"
import { endAutoResumes, endStreak, pauseOnGivingUp } from "./automation-auto-pause.js"
import { parseLease } from "./automation-lease.js"
import { JobLeaseLostError } from "@arden-hq/jobs"
import { Effect } from "effect"
import {
  AUTOMATION_JOB_OUTCOME,
  AUTOMATION_JOB_STATUS,
  type AutomationJobOutcome,
  type AutomationJobResult,
  type AutomationJobSkip
} from "../automations/store.js"
import {
  ranOutcome,
  TRIGGER_STATE,
  type AutomationRunOutcome
} from "@arden-hq/protocol/automations"
import { deleteAutomationRow } from "./automation-removal.js"
import { decodeJson } from "./json.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { AutomationTriggersSchema, scheduleEffect } from "./automation-schedule.js"
import { makeTriggerArming } from "./automation-trigger-arming.js"
import { makeAutomationEventDispatch } from "./automation-event-dispatch.js"
import { raiseRunEnded } from "./automation-run-ended.js"
import {
  type StoreOperation,
  type QueueEntry,
  boundAttemptJson,
  storeError,
  decodeBoundAttempt,
  decodeOwner,
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
import { decodeQueueContext } from "./automation-queue-context.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import type { BoundAttempt } from "./automation-rows.js"
import type { QueueContext } from "./automation-queue-context.js"
import type { AutomationStoreError } from "../automations/store.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { JsonColumnError } from "./json.js"
import type { SessionLifecycleEventError } from "../sessions/events.js"
import type { WorkStoreError } from "../work/store.js"
import type { UnitOfWork } from "../unit-of-work.js"
import type { WorkOwner } from "./automation-owner.js"
import { JOB_PURPOSE } from "../job-classification.js"

const SETTLE = { complete: "complete", fail: "fail", claim: "claim" } as const

type SettleOperation = (typeof SETTLE)[keyof typeof SETTLE]

type FencedDeps = Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules">

interface FencedJob {
  readonly parsed: ReturnType<typeof parseLease>
  readonly queue: Pick<QueueEntry, "task_id" | "source">
  readonly pinned: { readonly chatRunId: string | null; readonly chatSessionId: string | null }
  readonly bound: BoundAttempt
  readonly owner: WorkOwner | undefined
  readonly context: QueueContext
}

export interface FencedOccurrences {
  readonly loadFenced: (
    input: { readonly id: string; readonly token: string },
    operation: StoreOperation,
    now: number
  ) => Effect.Effect<FencedJob, AutomationStoreError>
  readonly settleFenced: (
    fenced: FencedJob,
    settledAt: number,
    operation: SettleOperation,
    ending: AutomationJobResult | AutomationJobSkip
  ) => Effect.Effect<
    void,
    SqlError | AutomationStoreError | JsonColumnError | SessionLifecycleEventError | WorkStoreError,
    UnitOfWork
  >
}

export const makeFencedOccurrences = ({
  writer,
  sessionEvents,
  rules
}: FencedDeps): FencedOccurrences => {
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
    operation: SettleOperation,
    ending: AutomationJobResult | AutomationJobSkip
  ) {
    const settled =
      ending.status === AUTOMATION_JOB_STATUS.ended && ending.chatRunId !== null
        ? { runId: ending.chatRunId, sessionId: ending.chatSessionId }
        : {
            runId: fenced.pinned.chatRunId,
            sessionId: fenced.pinned.chatSessionId
          }
    const settledRunId = settled.runId
    const settledSessionId = settled.sessionId
    if (operation === SETTLE.complete && settledRunId !== null) {
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
      ending.status === AUTOMATION_JOB_STATUS.skipped
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
    const taskItemId = purpose === JOB_PURPOSE.taskExecution ? fenced.bound.itemId : null
    const internalSpaceJob = isSpaceWorkJob(fenced.bound)
    const definition = isDefinition(fenced.owner) ? fenced.owner : undefined
    const automation = definition?.kind === JOB_SUBJECT_KIND.automation ? definition : undefined
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
            { times: schedule.times.filter((time) => time.kind === TRIGGER_STATE.once) },
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
      enabled = followup.action === AUTOMATION_FOLLOWUP.stop ? 0 : undefined
      nextRunAt = followup.action === AUTOMATION_FOLLOWUP.stop ? null : followup.at
      if (followup.action !== AUTOMATION_FOLLOWUP.stop)
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
    const counted = ending.status !== AUTOMATION_JOB_STATUS.skipped
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
      outcome === AUTOMATION_JOB_OUTCOME.failed
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
      (isUserAutomationPurpose(purpose) || purpose === JOB_PURPOSE.system)
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
      definition !== undefined && outcome === AUTOMATION_JOB_OUTCOME.failed && userAutomation
        ? yield* pauseOnGivingUp({
            sql,
            sessionEvents,
            automationId: fenced.queue.task_id,
            attemptId: fenced.parsed.runId,
            chatRunId: settledRunId
          })
        : false
    yield* sql`DELETE FROM automation_event_queue WHERE id = ${fenced.parsed.queueId}`
    if (
      fenced.owner?.kind === JOB_SUBJECT_KIND.spaceReview &&
      outcome === AUTOMATION_JOB_OUTCOME.failed
    )
      yield* spaceJobs.retryReview(fenced.owner, endedAt)
    yield* consumeIdleInput({ sql, automationId: fenced.queue.task_id, context: fenced.context })
    if (taskItemId !== null && outcome === AUTOMATION_JOB_OUTCOME.failed) {
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
            SELECT COUNT(*) AS count, COALESCE(MIN(chat.status = 'completed' AND ${quietRunOutcome(sql, "chat")}
              AND NOT EXISTS (SELECT 1 FROM tool_calls AS made WHERE made.run_id = chat.run_id
                AND made.tool_name IN ${sql.in(HANDLER_TOOL_NAMES)} AND made.status = 'completed'
                AND COALESCE(json_extract(made.result_json, '$.is_error'), 0) = 0)), 0) AS quiet
            FROM chat_runs AS chat JOIN automation_runs AS attempt ON attempt.id = ${attemptId}
            WHERE json_extract(chat.metadata_json, '$.run_context.origin') = json(attempt.origin)`
    const ranModel = (admitted[0]?.count ?? 0) > 0
    const declared = noInput(ending.outcome, ranModel)
    return declared === AUTOMATION_JOB_OUTCOME.finished && ranModel && admitted[0]?.quiet === 1
      ? "no_change"
      : declared
  })

  return { loadFenced, settleFenced }
}

const jobDone = (input: {
  readonly purpose: JobPurpose
  readonly enabled: boolean
  readonly outcome: AutomationRunOutcome
  readonly followup: AutomationFollowup["action"] | undefined
  readonly spent: boolean
}): boolean =>
  isUserAutomationPurpose(input.purpose) &&
  input.enabled &&
  (input.outcome === AUTOMATION_JOB_OUTCOME.finished ||
    input.outcome === AUTOMATION_JOB_OUTCOME.no_change) &&
  (input.followup === AUTOMATION_FOLLOWUP.stop || (input.followup === undefined && input.spent))

const noInput = (
  outcome: AutomationJobOutcome,
  ranModel: boolean
): Exclude<AutomationJobOutcome, "no_input"> => {
  if (outcome !== AUTOMATION_JOB_OUTCOME.no_input) return outcome
  return ranModel ? "finished" : "no_change"
}
