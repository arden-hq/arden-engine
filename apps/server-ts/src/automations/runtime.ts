import { backoffDelayMs } from "@arden-hq/std/retry"
import { HomeStore } from "../persistence/home/store.js"
import { HomeLetterInputs } from "../persistence/automations/home-letter-inputs.js"
import { SpaceReviewStore } from "../persistence/automations/space-review-store.js"
import { AutomationHandlerItems } from "../persistence/automations/handler-items.js"
import { triggerFeedRecord } from "./trigger-feed.js"
import { makeSpaceReviewRunner } from "./space-review.js"
import { WorkerStatus } from "./worker-status.js"
import { makeHandlerItemRunner } from "./handler-item-run.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { SummaryStore } from "../persistence/summaries/store.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { Decisions } from "../models/decisions/service.js"
import { screenEventWake } from "./prefilter.js"
import { screenSpaceReview } from "./space-review-gate.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { makeSpaceOverview } from "../memory/space-overview.js"
import { TaskProposalStore } from "../persistence/proposals/store.js"
import { makeChatOutcomeLinker } from "../routing/chat-outcome.js"
import { makeJobWorker } from "@arden-hq/jobs"
import { makeAutomationJobRunner } from "./job-run.js"
import { renderAutomationJob, withTriggerContext } from "./job-prompt.js"
import { Cause, Clock, Context, Deferred, Effect, Layer, Record, Scope, Stream } from "effect"
import { IntelligenceSettingsStore, LimitSettingsStore } from "../persistence/settings/store.js"
import { ModelProviderService } from "../models/provider.js"
import { automationLimitPercent, quotaDecision, quotaLimits } from "../models/plan-limits.js"
import { PlanLimitPause, awaitEnded, isNoModelProvider, jobResult } from "./runner.js"
import { WorkStore } from "../persistence/work/store.js"
import { taskOfJob } from "../persistence/space-job-id.js"
import { StoragePolicyStore } from "../persistence/storage/store.js"
import { ChatMessage } from "../chat/message.js"
import { Memory } from "../memory/service.js"
import { SYSTEM_AUTOMATION_SPECS, SYSTEM_HANDLERS } from "./system.js"
import type { SystemHandlerServices } from "./system-handler.js"
import { AutomationQueue } from "../persistence/automations/queue.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import {
  AutomationStoreError,
  type AutomationJobDeferral,
  type AutomationJobLease,
  type AutomationJobLeaseRef,
  type AutomationJobSettlement,
  type ClaimedAutomationJobLease,
  type AutomationJobResult
} from "../persistence/automations/store.js"
import { AutomationTriggers, type TriggerFeedRecord } from "../persistence/automations/triggers.js"
import {
  SessionLifecycleEvents,
  type SessionLifecycleDelivery
} from "../persistence/sessions/events.js"
import { WikiMaintenanceStore } from "../persistence/wiki-maintenance/store.js"
import { Wiki } from "../wiki/service.js"
import { Diagnostics } from "../runtime/diagnostics.js"
import type { AutomationId } from "../persistence/automations/model.js"
import { iso } from "../runtime/clock.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"

const MAX_JOB_ATTEMPTS = 3

const NO_MODEL_RETRY_MS = 30_000

export class AutomationRuntime extends Context.Service<
  AutomationRuntime,
  {
    readonly awaitReady: Effect.Effect<void, AutomationStoreError>
    readonly runNow: (automationId: AutomationId) => Effect.Effect<boolean, AutomationStoreError>
    readonly runWithEvent: (
      automationId: AutomationId,
      skippedRunId: number
    ) => Effect.Effect<boolean, AutomationStoreError>
  }
>()("@arden-hq/server/automations/AutomationRuntime") {
  static readonly layer: Layer.Layer<
    AutomationRuntime,
    AutomationStoreError,
    | AutomationCatalog
    | AutomationQueue
    | AutomationTriggers
    | HomeLetterInputs
    | SpaceReviewStore
    | AutomationHandlerItems
    | ChatMessage
    | Memory
    | SessionLifecycleEvents
    | Wiki
    | WikiMaintenanceStore
    | StoragePolicyStore
    | HomeStore
    | IntelligenceSettingsStore
    | LimitSettingsStore
    | ModelProviderService
    | WorkerStatus
    | SessionStore
    | TranscriptQueries
    | SummaryStore
    | StructuredCompletion
    | Decisions
    | SpaceStore
    | WorkStore
    | TaskProposalStore
  > = Layer.effect(
    AutomationRuntime,
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics
      const workerStatus = yield* WorkerStatus
      const settings = yield* IntelligenceSettingsStore
      const limitSettings = yield* LimitSettingsStore
      const modelProvider = yield* ModelProviderService
      const retentionPolicy = yield* StoragePolicyStore
      const store = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const triggers = yield* AutomationTriggers
      const homeLetterInputs = yield* HomeLetterInputs
      const spaceReviews = yield* SpaceReviewStore
      const handlerItems = yield* AutomationHandlerItems
      const chat = yield* ChatMessage
      const work = yield* WorkStore
      const home = yield* HomeStore
      const memory = yield* Memory
      const sessionEvents = yield* SessionLifecycleEvents
      const wiki = yield* Wiki
      const wikiMaintenance = yield* WikiMaintenanceStore
      const sessions = yield* SessionStore
      const transcripts = yield* TranscriptQueries
      const summaries = yield* SummaryStore
      const spaceOverview = makeSpaceOverview({
        completion: yield* StructuredCompletion,
        summaries
      })
      const linkOfferChat = makeChatOutcomeLinker({
        spaces: yield* SpaceStore,
        proposals: yield* TaskProposalStore,
        completion: yield* StructuredCompletion
      })
      const decisions = yield* Decisions
      const screenWake = screenEventWake(decisions)
      const lifecycle = yield* ServerLifecycle
      yield* triggers.triggerCursor()
      const ready = yield* Deferred.make<void, AutomationStoreError>()
      let failure: AutomationStoreError | undefined
      const awaitReady = Effect.gen(function* () {
        yield* Effect.raceFirst(
          Deferred.await(ready),
          lifecycle.quiescing.pipe(Effect.andThen(Effect.interrupt))
        )
        if (failure !== undefined) return yield* failure
        if (!lifecycle.isAccepting()) return yield* Effect.interrupt
      })

      const awaitChatRun = (chatRunId: string) => awaitEnded(queue.observeChatRun(chatRunId))

      const services: SystemHandlerServices = {
        chat,
        queue,
        homeLetterInputs,
        handlerItems,
        home,
        memory,
        wiki,
        wikiMaintenance,
        retentionPolicy,
        sessions,
        summaries,
        spaceOverview,
        linkOfferChat,
        transcripts,
        awaitRun: awaitChatRun,
        runItem: makeHandlerItemRunner({ chat, handlerItems, awaitRun: awaitChatRun })
      }
      const runners = Record.map(SYSTEM_HANDLERS, (handler) => handler.run(services))
      const executeHandler = (
        job: AutomationJobLease
      ): Effect.Effect<AutomationJobResult, Error> =>
        job.payload.handler === null
          ? Effect.die(new Error("Automation job has no handler"))
          : runners[job.payload.handler](job)

      const executeChat = makeAutomationJobRunner({
        chat,
        queue,
        executeHandler
      })
      const executeReview = makeSpaceReviewRunner({
        wiki,
        spaceReviews,
        screen: screenSpaceReview({ decisions, spaceReviews }),
        execute: executeChat
      })
      const executeTask = Effect.fn("AutomationRuntime.executeTask")(function* (
        job: AutomationJobLease
      ) {
        const itemId = taskOfJob(job.payload.automationId)
        if (itemId === undefined) return yield* executeChat(job)
        if (!(yield* work.runsInChat(itemId))) {
          const settlement = yield* executeChat(job)
          if (yield* work.runsInChat(itemId))
            yield* chat.continueTask({ itemId, sourceId: `handoff:${job.payload.automationRunId}` })
          return settlement
        }
        yield* chat.continueTask({ itemId, sourceId: `wake:${job.payload.automationRunId}` })
        return jobResult.withoutRun("no_change", "Arden works on it in its chat.")
      })
      const run = (job: AutomationJobLease) => {
        if (job.payload.purpose === "space_review") return executeReview(job)
        if (job.payload.purpose === "task_execution") return executeTask(job)
        return executeChat(job)
      }
      const planLimitDeferral = (
        sessionId: string | null,
        until: number
      ): AutomationJobDeferral => ({
        status: "deferred",
        cause: "plan_limit",
        reason: `Waiting for the plan limit to reset at ${iso(until)}`,
        retryAt: until,
        sessionId
      })
      const noModelDeferral = (reason: string) =>
        Effect.map(Clock.currentTimeMillis, (now): AutomationJobDeferral => ({
          status: "deferred",
          cause: "no_model",
          reason,
          retryAt: now + NO_MODEL_RETRY_MS,
          sessionId: null
        }))
      const planLimitHold = Effect.fn("AutomationRuntime.planLimitHold")(function* (
        job: AutomationJobLeaseRef
      ) {
        const reading = modelProvider.current()?.planLimits?.latest()
        if (reading === undefined) return undefined
        const limits = yield* limitSettings.settings()
        const decision = quotaDecision({
          reading,
          limits: quotaLimits(limits),
          quotaClass: job.payload.purpose === "task_execution" ? "interactive" : "background",
          itemLimitPercent: automationLimitPercent(limits, job.payload.automationId),
          now: yield* Clock.currentTimeMillis
        })
        return decision.kind === "pause" ? decision.until : undefined
      })
      const screened = Effect.fn("AutomationRuntime.screened")(function* (
        job: ClaimedAutomationJobLease
      ) {
        const screen = yield* screenWake(job)
        if (screen === undefined) return { kind: "run" as const, job }
        const outcome = yield* queue.recordEventScreen({
          lease: job,
          screen,
          now: yield* Clock.currentTimeMillis
        })
        return outcome.kind === "skip"
          ? outcome
          : { kind: "run" as const, job: withTriggerContext(job, outcome.triggerContext) }
      })
      const execute = (
        claimed: ClaimedAutomationJobLease
      ): Effect.Effect<AutomationJobSettlement, Error> =>
        Effect.gen(function* () {
          const until = yield* planLimitHold(claimed)
          if (until !== undefined) return planLimitDeferral(claimed.payload.sessionId, until)
          const wake = yield* screened(claimed)
          if (wake.kind === "skip") return { status: "skipped" as const, skip: wake.skip }
          return yield* run(renderAutomationJob(wake.job))
        }).pipe(
          Effect.catch((cause) => {
            if (cause instanceof PlanLimitPause) {
              return Effect.succeed(planLimitDeferral(cause.sessionId, cause.until))
            }
            if (isNoModelProvider(cause)) {
              return noModelDeferral(cause.message)
            }
            return Effect.fail(cause)
          })
        )

      const scope = yield* Scope.Scope
      const initialize = Effect.scoped(
        Effect.gen(function* () {
          yield* store.seedSystemAutomations(SYSTEM_AUTOMATION_SPECS)
          yield* diagnostics.startupPhase("automation_seeds_ready")
          const maintenanceBaseline = yield* wiki.head()
          yield* wikiMaintenance.initialize(maintenanceBaseline)
          yield* diagnostics.startupPhase("automation_wiki_ready")
          yield* store.reconcileSpaceJobs()
          yield* diagnostics.startupPhase("automation_space_jobs_ready")
          yield* triggers.rearmIdleTriggers()
          yield* diagnostics.startupPhase("automation_recovery_ready")

          const context = yield* Effect.context<never>()
          const runPromise = Effect.runPromiseWith(context)
          const worker = makeJobWorker({
            driver: queue.jobs,
            now: () => Effect.runSyncWith(context)(Clock.currentTimeMillis),
            execute: (job, lease) => runPromise(execute(job), { signal: lease.signal }),
            concurrency: () =>
              runPromise(
                settings.settings().pipe(Effect.map((current) => current.maxConcurrentWorkers))
              ),
            leaseDurationMs: 30_000,
            maxAttempts: MAX_JOB_ATTEMPTS,
            retryDelayMs: (attempt) => backoffDelayMs({ initialMs: 500, maxMs: 10_000 }, attempt),
            onError: (cause) => runPromise(Effect.logWarning("Automation worker error", cause))
          })
          const detachStatus = workerStatus.attach(worker)
          yield* Scope.addFinalizer(scope, Effect.sync(detachStatus))
          yield* Scope.addFinalizer(
            scope,
            Effect.promise(() => worker.stop())
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => worker.quiesce()))

          let workerStarted = false
          const startWorker = Effect.gen(function* () {
            if (workerStarted) return
            if (!lifecycle.isAccepting()) return yield* Effect.interrupt
            worker.start()
            workerStarted = true
            yield* diagnostics.startupPhase("automation_worker_started")
            yield* diagnostics.startupPhase("automation_ready")
            yield* Deferred.succeed(ready, undefined)
          })

          const toRecord = Effect.fn("AutomationRuntime.toRecord")(function* (
            delivery: SessionLifecycleDelivery
          ): Effect.fn.Return<TriggerFeedRecord> {
            if (delivery.kind !== "reset") return triggerFeedRecord(delivery)
            return {
              sequence: delivery.cursor,
              atMs: yield* Clock.currentTimeMillis,
              kind: "other",
              sessionId: null,
              journal: undefined
            }
          })

          const followTriggers = Effect.scoped(
            Effect.gen(function* () {
              const cursor = yield* triggers.triggerCursor()
              const { stream: records } = yield* sessionEvents.open(cursor.afterSequence)
              let catchingUp = cursor.afterSequence < cursor.head
              if (!catchingUp) yield* startWorker
              yield* Stream.runForEach(
                records,
                Effect.fn("AutomationRuntime.followTriggers.delivery")(function* (delivery) {
                  const record = yield* toRecord(delivery)
                  yield* triggers.applyTriggerFeedRecord(record)
                  if (catchingUp) {
                    if (record.sequence >= cursor.head) {
                      catchingUp = false
                      yield* triggers.rearmIdleTriggers()
                      yield* startWorker
                    }
                    return
                  }
                  worker.wake()
                })
              )
            })
          )
          yield* followTriggers
        })
      ).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          failure = new AutomationStoreError({
            operation: "reconcile_space_jobs",
            reason: "storage",
            message: "Could not initialize Automations",
            cause
          })
          return Effect.fail(failure)
        }),
        Effect.onExit((exit) => Deferred.done(ready, exit))
      )
      yield* lifecycle.background(initialize)
      return AutomationRuntime.of({
        awaitReady,
        runNow: (automationId) => awaitReady.pipe(Effect.andThen(queue.requestRun(automationId))),
        runWithEvent: (automationId, skippedRunId) =>
          awaitReady.pipe(Effect.andThen(queue.requestRunWithEvent(automationId, skippedRunId)))
      })
    })
  )
}
