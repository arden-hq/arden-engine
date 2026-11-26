import { LocalCaller } from "../middleware/local-only.js"
import { runListOptions } from "@arden-hq/protocol/effect/runs"
import { RUN_LIST_FILTER, RUN_PAGE, RUN_PAGE_NEXT, RUN_TRACE } from "@arden-hq/protocol/runs"
import { runDetail } from "./run-detail.js"
import { wireSessionRun, wireUsageReport } from "./usage-wire.js"
import { wirePlanLimits } from "./plan-limits-wire.js"
import type { SessionUsageReport } from "@arden-hq/protocol/runs"
import { DateTime, Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { currentPlanReading, planLimitsReport, stopPercent } from "../../models/plan-limits.js"
import { LimitSettingsStore } from "../../persistence/settings/store.js"
import { ModelStore } from "../../persistence/models/store.js"
import { ModelProviderService } from "../../models/provider.js"
import { ChatEventStore } from "../../persistence/events/store.js"
import { RunQueries } from "../../persistence/runs/queries.js"
import { UsageStore, UsageStoreError } from "../../persistence/usage/store.js"
import { ArdenApi } from "../api.js"
import { failInternal, storeErrorToHttp } from "../errors.js"
import { currentMillis } from "../../runtime/clock.js"

/** Joins a start time and a Run id into the list's `next` cursor. A start
 * time never holds it. */
const RUN_LIST_CURSOR_SEPARATOR = "|"

const elapsedSeconds = (now: DateTime.Utc, then: DateTime.Utc): number =>
  Math.max(0, Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(then)) / 1_000))

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
      .handle(
        "list",
        Effect.fn("RunsHandlers.list")(function* ({ query }) {
          // Every chat's Runs at once is the owner's view; the command line sees its own chats.
          if ((yield* LocalCaller) === "cli") return yield* new HttpApiError.Forbidden({})
          const options = runListOptions(query)
          const cut =
            options.page.kind === RUN_PAGE.after
              ? options.page.cursor.indexOf(RUN_LIST_CURSOR_SEPARATOR)
              : -1
          const snapshot = yield* queries
            .list({
              ...(options.page.kind === RUN_PAGE.first || cut < 0
                ? {}
                : {
                    after: {
                      startedAt: options.page.cursor.slice(0, cut),
                      runId: options.page.cursor.slice(cut + 1)
                    }
                  }),
              ...(options.filter.kind === RUN_LIST_FILTER.all
                ? {}
                : { sessionId: options.filter.session_id }),
              activeOnly: options.active,
              limit: options.limit
            })
            .pipe(Effect.catch(failInternal("Runs")))
          const last = snapshot.runs.at(-1)
          return {
            runs: snapshot.runs.map((run) => ({
              run_id: run.runId,
              session_id: run.sessionId,
              status: run.status,
              active: run.active,
              started_at: run.startedAt
            })),
            next:
              snapshot.more && last !== undefined
                ? {
                    kind: RUN_PAGE_NEXT.more,
                    cursor: `${last.startedAt}${RUN_LIST_CURSOR_SEPARATOR}${last.runId}`
                  }
                : { kind: RUN_PAGE_NEXT.end },
            idle:
              snapshot.pendingDeliveries === 0 &&
              snapshot.runningScripts === 0 &&
              !snapshot.anyActive
          }
        })
      )
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
        }).pipe(Effect.catch(failInternal("Runs")))
      )
      .handle(
        "detail",
        Effect.fn("RunHandlers.detail")(function* ({ params }) {
          const run = yield* queries.get(params.runId).pipe(Effect.catch(failInternal("Runs")))
          if (run === null) return yield* new HttpApiError.NotFound({})
          const memory = yield* queries
            .memoryContext(run.runId)
            .pipe(Effect.catch(failInternal("Runs")))
          return yield* runDetail(run, memory)
        })
      )
      .handle(
        "progress",
        Effect.fn("RunHandlers.progress")(function* ({ params }) {
          const progress = yield* queries
            .progress(params.runId)
            .pipe(Effect.catch(failInternal("Runs")))
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
              afterSequence: query.after_sequence,
              limit: query.limit
            })
            .pipe(Effect.catch(failInternal("Runs")))
          if (page === null) return yield* new HttpApiError.NotFound({})
          return {
            run_id: page.runId,
            session_id: page.sessionId,
            trace:
              page.traceRemovedAt === null
                ? { kind: RUN_TRACE.kept }
                : { kind: RUN_TRACE.removed, at: page.traceRemovedAt },
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
          return wirePlanLimits(
            planLimitsReport(
              reading,
              source?.history() ?? [],
              stopPercent(settings.ardenLimit) ?? 100,
              now
            )
          )
        }).pipe(Effect.catch(failInternal("Runs")))
      )
      .handle("usage", ({ query }) =>
        usage.report({ days: query.days }).pipe(
          Effect.map(wireUsageReport),
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
            .sessionUsage({ sessionId: params.sessionId, limit: query.limit })
            .pipe(Effect.mapError(storeErrorToHttp))
          const windows = yield* contextWindows(stored.runs.map((run) => run.model_id))
          return {
            session_id: stored.session_id,
            runs: stored.runs.map((run) =>
              wireSessionRun(
                run,
                run.model_id === null ? null : (windows.get(run.model_id) ?? null)
              )
            )
          } satisfies SessionUsageReport
        })
      )
  })
)
