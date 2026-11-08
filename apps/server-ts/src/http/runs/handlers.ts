import {
  RunLocalInstructionSourceSchema,
  RunTerminalResultSchema
} from "@arden-hq/protocol/effect/runs"
import type { RunDetail, SessionUsageReport } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { currentPlanReading, planLimitsReport } from "../../models/plan-limits.js"
import { LimitSettingsStore } from "../../persistence/settings/store.js"
import { ModelStore } from "../../persistence/models/store.js"
import { ModelProviderService } from "../../models/provider.js"
import type { ChatRunRecord } from "../../persistence/runs/model.js"
import { ChatEventStore } from "../../persistence/events/store.js"
import { RunQueries } from "../../persistence/runs/queries.js"
import { UsageStore, UsageStoreError } from "../../persistence/usage/store.js"
import { ArdenApi } from "../api.js"
import { storeErrorToHttp } from "../errors.js"
import { currentMillis } from "../../runtime/clock.js"

const elapsedSeconds = (now: DateTime.Utc, then: DateTime.Utc): number =>
  Math.max(0, Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(then)) / 1_000))

const runDetail = Effect.fn("RunHandlers.runDetail")(function* (
  run: ChatRunRecord
): Effect.fn.Return<RunDetail, HttpApiError.InternalServerError> {
  const storedResult = run.metadata.terminal_result
  const result =
    storedResult === undefined || storedResult === null
      ? null
      : yield* Schema.decodeUnknownEffect(RunTerminalResultSchema)(storedResult).pipe(
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
  const localInstructions =
    run.metadata.local_instructions === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.Array(RunLocalInstructionSourceSchema))(
          run.metadata.local_instructions
        ).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
  return {
    version: 1 as const,
    run_id: run.runId,
    session_id: run.sessionId,
    turn_id: run.turnId,
    status: run.status,
    started_at: DateTime.formatIso(run.startedAt),
    updated_at: DateTime.formatIso(run.updatedAt),
    ended_at: run.endedAt === null ? null : DateTime.formatIso(run.endedAt),
    stop_reason: run.stopReason,
    last_event_sequence: run.lastSequence,
    model_id: run.modelId,
    reasoning_effort: run.reasoningEffort,
    client_id: run.clientId,
    result,
    late_result_at:
      run.metadata.late_result_at === undefined || run.metadata.late_result_at === null
        ? null
        : yield* Schema.decodeUnknownEffect(Schema.String)(run.metadata.late_result_at).pipe(
            Effect.mapError(() => new HttpApiError.InternalServerError({}))
          ),
    error:
      run.errorCode === null || run.errorMessage === null
        ? null
        : { code: run.errorCode, message: run.errorMessage },
    ...(localInstructions === undefined ? {} : { local_instructions: localInstructions })
  } satisfies RunDetail
})

const internalError = (_error: unknown): HttpApiError.InternalServerError =>
  new HttpApiError.InternalServerError({})

export const RunHandlers = HttpApiBuilder.group(
  ArdenApi,
  "runs",
  Effect.fn("RunHandlers")(function* (handlers) {
    const queries = yield* RunQueries
    const events = yield* ChatEventStore
    const usage = yield* UsageStore
    const models = yield* ModelProviderService
    const modelSettings = yield* ModelStore
    const limitSettings = yield* LimitSettingsStore

    const contextWindows = (modelIds: ReadonlyArray<string | null>) =>
      Effect.forEach([...new Set(modelIds.filter((id) => id !== null))], (modelId) =>
        modelSettings.contextBudget({ modelId, inputTokens: 0, messageCount: 0 }).pipe(
          Effect.map((budget) => [modelId, budget.hard_limit] as const),
          Effect.orElseSucceed(() => [modelId, null] as const)
        )
      ).pipe(Effect.map((pairs) => new Map<string, number | null>(pairs)))

    return handlers
      .handle("status", () =>
        Effect.gen(function* () {
          const snapshot = yield* queries.listActive()
          const observedAt = yield* DateTime.now
          return {
            observed_at: DateTime.formatIso(observedAt),
            total_retained: snapshot.totalRetained,
            active_runs: snapshot.runs.map((run) => ({
              run_id: run.runId,
              turn_id: run.turnId,
              session_id: run.sessionId,
              status: run.status,
              created_at: DateTime.formatIso(run.startedAt),
              updated_at: DateTime.formatIso(run.updatedAt),
              age_seconds: elapsedSeconds(observedAt, run.startedAt),
              idle_seconds: elapsedSeconds(observedAt, run.updatedAt),
              message_count: run.messageCount,
              pending_injections: run.pendingInjections,
              approvals_pending: run.approvalsPending
            }))
          }
        }).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      )
      .handle(
        "detail",
        Effect.fn("RunHandlers.detail")(function* ({ params }) {
          const run = yield* queries.get(params.runId).pipe(Effect.mapError(internalError))
          if (run === null) return yield* new HttpApiError.NotFound({})
          return yield* runDetail(run)
        })
      )
      .handle(
        "progress",
        Effect.fn("RunHandlers.progress")(function* ({ params }) {
          const progress = yield* queries
            .progress(params.runId)
            .pipe(Effect.mapError(internalError))
          if (progress === null) return yield* new HttpApiError.NotFound({})
          return {
            ...progress,
            purpose: events.currentActivity(progress.session_id, progress.run_id)?.purpose ?? null
          }
        })
      )
      .handle(
        "events",
        Effect.fn("RunHandlers.events")(function* ({ params, query }) {
          const page = yield* queries
            .events({
              runId: params.runId,
              afterSequence: query.after_sequence ?? 0,
              limit: query.limit ?? 100
            })
            .pipe(Effect.mapError(internalError))
          if (page === null) return yield* new HttpApiError.NotFound({})
          return {
            run_id: page.runId,
            session_id: page.sessionId,
            trace_removed_at: page.traceRemovedAt,
            events: page.events.map((record) => ({
              sequence: record.sequence,
              created_at: record.createdAt,
              event: record.event
            })),
            next_after_sequence: page.nextAfterSequence,
            has_more: page.hasMore
          }
        })
      )
      .handle("planLimits", () =>
        Effect.gen(function* () {
          const settings = yield* limitSettings.settings()
          const source = models.current()?.planLimits
          const now = currentMillis()
          const reading =
            source === undefined
              ? undefined
              : yield* Effect.promise(() => currentPlanReading(source, now))
          return planLimitsReport(
            reading,
            source?.history() ?? [],
            settings.ardenLimitPercent ?? 100,
            now
          )
        }).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      )
      .handle("usage", ({ query }) =>
        usage
          .report({ days: query.days ?? 7 })
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof UsageStoreError
                ? storeErrorToHttp(cause)
                : new HttpApiError.InternalServerError({})
            )
          )
      )
      .handle(
        "sessionUsage",
        Effect.fn("RunHandlers.sessionUsage")(function* ({ params, query }) {
          const stored = yield* usage
            .sessionUsage({ sessionId: params.sessionId, limit: query.limit ?? 20 })
            .pipe(Effect.mapError(storeErrorToHttp))
          const windows = yield* contextWindows(stored.runs.map((run) => run.model_id))
          return {
            session_id: stored.session_id,
            runs: stored.runs.map((run) => ({
              ...run,
              context_window: run.model_id === null ? null : (windows.get(run.model_id) ?? null)
            }))
          } satisfies SessionUsageReport
        })
      )
  })
)
