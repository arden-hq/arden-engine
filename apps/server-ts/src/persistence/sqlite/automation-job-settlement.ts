import { OPERATIONAL_SESSION } from "@arden-hq/protocol/daemon"
import {
  JobLeaseLostError,
  type JobCompleteInput,
  type JobFailInput,
  type JobReleaseInput
} from "@arden-hq/jobs"
import { Effect } from "effect"
import {
  AUTOMATION_JOB_STATUS,
  AutomationStoreError,
  type AutomationJobDeferral,
  type AutomationJobResult,
  type AutomationJobSettlement,
  type AutomationJobSkip
} from "../automations/store.js"
import { storeError, isDefinition, type WorkOwner } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import { makeFencedOccurrences } from "./automation-fenced-occurrence.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import type { WorkStoreError } from "../work/store.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { JsonColumnError } from "./json.js"
import type { SessionLifecycleEventError } from "../sessions/events.js"

const AUTOMATION_DEFERRAL_MIN_MS = 1_000

const AUTOMATION_DEFERRAL_MAX_MS = 30_000

const PLAN_LIMIT_RECHECK_MS = 15 * 60_000

const LONGEST_DEFERRAL_MS: Record<AutomationJobDeferral["cause"], number> = {
  session_busy: AUTOMATION_DEFERRAL_MAX_MS,
  no_model: AUTOMATION_DEFERRAL_MAX_MS,
  plan_limit: PLAN_LIMIT_RECHECK_MS
}

export type SettlementDeps = Pick<
  AutomationStoreDeps,
  "writer" | "sessionEvents" | "rules" | "diagnostics"
>

type SettlementFailure =
  | AutomationStoreError
  | ((WorkStoreError | SqlError | JsonColumnError | SessionLifecycleEventError) & JobLeaseLostError)

export interface AutomationJobSettlementStore {
  readonly completeEffect: (
    input: JobCompleteInput<AutomationJobSettlement>
  ) => Effect.Effect<void, SettlementFailure>
  readonly failEffect: (input: JobFailInput) => Effect.Effect<void, SettlementFailure>
  readonly releaseEffect: (
    input: JobReleaseInput
  ) => Effect.Effect<void, AutomationStoreError | (SqlError & JobLeaseLostError)>
}

export const makeAutomationJobSettlement = ({
  writer,
  sessionEvents,
  rules,
  diagnostics
}: SettlementDeps): AutomationJobSettlementStore => {
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
          const longest = LONGEST_DEFERRAL_MS[input.result.cause]
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
      session:
        input.result.sessionId === null
          ? { kind: OPERATIONAL_SESSION.none }
          : { kind: OPERATIONAL_SESSION.session, sessionId: input.result.sessionId }
    })
  })

  const completeEffect = (input: JobCompleteInput<AutomationJobSettlement>) => {
    const result = input.result
    switch (result.status) {
      case AUTOMATION_JOB_STATUS.deferred:
        return deferEffect({ ...input, result })
      case AUTOMATION_JOB_STATUS.skipped:
      case AUTOMATION_JOB_STATUS.ended:
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
