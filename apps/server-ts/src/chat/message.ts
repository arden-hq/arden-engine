import type { ChatSendReceipt, RunCancelTarget } from "../persistence/chat/send-contracts.js"
import type { CancelResponse } from "@arden-hq/protocol/chat"
import { Persistence } from "../persistence/service.js"
import { Context, Effect, Exit, Fiber, FiberMap, Layer, Option, Scope, Semaphore } from "effect"
import { ChatEventStore } from "../persistence/events/store.js"
import { WorkStore } from "../persistence/work/store.js"
import { LimitSettingsStore } from "../persistence/settings/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import {
  ChatWriteStore,
  type ChatWriteResume,
  type ChatWriteReceiveResult
} from "../persistence/chat/store.js"
import { ToolExecutionStore } from "../persistence/tools/store.js"
import { TerminalSessions } from "../terminals/service.js"
import { chatRunnerSource, type ChatRunnerOptions } from "./runner-source.js"
import { ModelProviderService, planReadingFor } from "../models/provider.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { makeAgentRunScheduler } from "./agent-run-scheduler.js"
import { makePendingArrivals } from "./pending-arrivals.js"
import { isApprovalMode } from "@arden-hq/protocol/permissions"
import { type ToolHost } from "./durable-tools.js"
import { makeHeldBackground, stopHeldOfEndedRuns } from "./held-background.js"
import { makeHelperJobs } from "./helper-jobs.js"
import { startRunRecovery } from "./run-recovery.js"
import { runChat } from "./run-driver.js"
import { type TaskContinuationInput, type RunHost, type RunServices } from "./run-driver-support.js"
import { ChatMessageError, mapWriteError, type ChatMessageFailure } from "./message-errors.js"
import { taskContinuation, receipt, type ChatSendInput } from "./message-input.js"
import type { ChatMessageShape, StopReason } from "./message-shape.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { makeDeliverBootArrivals } from "./message-boot.js"
import { makeResolveTool } from "./message-resolve-tool.js"
import { makeStartAutomation } from "./message-automation.js"
import { makeDetachedRun } from "./message-detached-run.js"
import { makePrepare } from "./message-prepare.js"
import { makeCancellation } from "./message-cancellation.js"

const drainStatus = (reason: StopReason): string =>
  reason === "quit"
    ? "Finishing the current tool, then quitting"
    : "Finishing the current tool, then restarting"

export class ChatMessage extends Context.Service<ChatMessage, ChatMessageShape>()(
  "@arden-hq/server/chat/ChatMessage"
) {
  static layer(
    options: ChatRunnerOptions,
    boot: {
      readonly arrivals?: () => ReadonlyArray<ChatSendInput>
      readonly acknowledgeArrival?: (arrival: ChatSendInput) => void
    } = {}
  ): Layer.Layer<
    ChatMessage,
    never,
    | ChatWriteStore
    | ChatEventStore
    | TranscriptQueries
    | ToolExecutionStore
    | WorkStore
    | RunQueries
    | Persistence
    | ModelProviderService
    | StructuredCompletion
    | SessionQueries
    | SessionStore
    | SpaceStore
    | LimitSettingsStore
    | TerminalSessions
  > {
    return Layer.effect(
      ChatMessage,
      Effect.gen(function* () {
        const store = yield* ChatWriteStore
        const events = yield* ChatEventStore
        const toolStore = yield* ToolExecutionStore
        const workStore = yield* WorkStore
        const limitSettings = yield* LimitSettingsStore
        const terminals = yield* TerminalSessions
        const context = yield* Effect.context<RunServices>()
        const runServices = Context.pick(
          ChatWriteStore,
          ChatEventStore,
          ToolExecutionStore,
          WorkStore
        )(context)
        const runs = yield* RunQueries
        const serverScope = yield* Scope.Scope
        const fibers = yield* FiberMap.make<string, void, unknown>()
        const lifecycle = yield* Semaphore.make(1)
        const serverLifecycle = yield* ServerLifecycle
        const activeRuns = new Map<
          string,
          { readonly controller: AbortController; readonly sessionId: string }
        >()
        const heldBackground = makeHeldBackground()
        const persistence = yield* Persistence
        let draining = false
        const accepting = Effect.suspend(() =>
          !draining && serverLifecycle.isAccepting()
            ? Effect.void
            : Effect.fail(
                new ChatMessageError({ reason: "unavailable", message: "Arden is stopping" })
              )
        )
        const agentRuns = makeAgentRunScheduler()
        const pendingArrivals = makePendingArrivals()
        yield* Scope.addFinalizer(
          serverScope,
          Effect.sync(() => {
            for (const { controller } of activeRuns.values()) controller.abort()
            activeRuns.clear()
            heldBackground.stop()
          })
        )
        const modelProvider = yield* ModelProviderService
        const chatRunner = chatRunnerSource(options, modelProvider)
        const { scheduleNaming, scheduleLetterSubject, scheduleRunPurpose } = yield* makeHelperJobs(
          { lifecycle }
        )

        const { requestCancellation, cancelAgent, stopRuns } = makeCancellation({
          store,
          terminals,
          runs,
          serverScope,
          fibers,
          lifecycle,
          activeRuns,
          heldBackground
        })

        const launch = (run: ChatWriteResume): Effect.Effect<void> => {
          const runner = chatRunner.current()
          if (runner === undefined || draining || !serverLifecycle.isAccepting()) return Effect.void
          const host: RunHost = {
            ...toolHost,
            runner,
            planReading: (model) => planReadingFor(modelProvider.current(), model),
            continueTask,
            scheduleLetterSubject,
            scheduleRunPurpose,
            waitForPendingMessages: pendingArrivals.wait
          }
          const controller = new AbortController()
          const entry = { controller, sessionId: run.sessionId }
          activeRuns.set(run.runId, entry)
          const background = agentRuns
            .run(
              run.scheduling,
              runChat(host, {
                sessionId: run.sessionId,
                runId: run.runId,
                model: run.model,
                reasoningEffort: run.reasoningEffort,
                approvalMode: run.approvalMode,
                outputSchema: run.outputSchema,
                automation: run.automation,
                automationContextMode: run.automationContextMode,
                turnId: run.turnId,
                storedMessages: run.activeMessages,
                signal: controller.signal,
                assistantMessageId: run.assistantMessageId,
                mintedMessageIds: run.mintedMessageIds,
                eventSequence: { value: run.eventSequence }
              }).pipe(Effect.provideContext(runServices)),
              { runId: run.runId, sessionId: run.sessionId }
            )
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (activeRuns.get(run.runId) === entry) activeRuns.delete(run.runId)
                  controller.abort()
                })
              ),
              Effect.ensuring(stopHeldOfEndedRuns(heldBackground, runs, [run.runId]))
            )
          return FiberMap.run(fibers, run.runId, background)
        }

        const launchStarted = (
          input: Pick<ChatSendInput, "sessionId" | "clientId" | "approvalReply">,
          assistantMessageId: string,
          started: ChatWriteReceiveResult
        ): Effect.Effect<ChatSendReceipt, ChatMessageFailure> => {
          const start = (): Effect.Effect<ChatSendReceipt> => {
            switch (started._tag) {
              case "Stored":
                return Effect.succeed(receipt(input, null, "accepted"))
              case "Queued":
                return Effect.sync(() => {
                  pendingArrivals.notify(started.runId)
                  return receipt(input, started.runId, "queued")
                })
              case "Existing":
                return Effect.succeed(receipt(input, started.runId, started.status))
              case "Started":
                return launch({
                  runId: started.runId,
                  sessionId: input.sessionId,
                  assistantMessageId,
                  mintedMessageIds: [],
                  model: started.model,
                  reasoningEffort: started.reasoningEffort,
                  approvalMode: started.approvalMode,
                  outputSchema: started.outputSchema,
                  automation: started.automation,
                  automationContextMode: started.automationContextMode,
                  turnId: started.turnId,
                  activeMessages: started.activeMessages,
                  eventSequence: started.committed.headSequence,
                  scheduling: started.scheduling
                }).pipe(Effect.as(receipt(input, started.runId, "running")))
            }
          }
          return start().pipe(
            Effect.tap(
              Effect.fn("ChatMessage.resumeApprovalReply")(function* () {
                if (input.approvalReply === undefined) return
                const resumed = yield* store
                  .claimResume(input.approvalReply.runId)
                  .pipe(Effect.mapError(mapWriteError))
                if (resumed !== null) yield* launch(resumed)
              })
            )
          )
        }

        const prepare = makePrepare({ store, workStore, chatRunner, scheduleNaming })

        const send = Effect.fn("ChatMessage.send")(function* (input: ChatSendInput) {
          const admit = yield* prepare(input)
          if (input.approvalReply !== undefined) {
            const active = yield* FiberMap.get(fibers, input.approvalReply.runId)
            if (Option.isSome(active)) yield* Fiber.await(active.value)
          }
          return yield* Effect.uninterruptible(
            lifecycle.withPermit(
              accepting.pipe(
                Effect.andThen(admit),
                Effect.flatMap((admitted) =>
                  launchStarted(admitted.input, admitted.assistantMessageId, admitted.started)
                )
              )
            )
          )
        })

        const sendTogether = Effect.fn("ChatMessage.sendTogether")(function* (
          inputs: ReadonlyArray<ChatSendInput>
        ) {
          const together = inputs.map((input) => input.clientId)
          const prepared = yield* Effect.forEach(inputs, (input) =>
            Effect.exit(prepare(input, together))
          )
          for (const input of inputs) {
            if (input.approvalReply === undefined) continue
            const active = yield* FiberMap.get(fibers, input.approvalReply.runId)
            if (Option.isSome(active)) yield* Fiber.await(active.value)
          }
          return yield* Effect.uninterruptible(
            lifecycle.withPermit(
              Effect.gen(function* () {
                const admission = yield* Effect.exit(accepting)
                if (Exit.isFailure(admission))
                  return inputs.map(() => Exit.failCause(admission.cause))
                const admitted = yield* Effect.forEach(prepared, (exit) =>
                  Exit.isFailure(exit)
                    ? Effect.succeed(Exit.failCause(exit.cause))
                    : Effect.exit(exit.value)
                )
                return yield* Effect.forEach(
                  admitted,
                  (exit): Effect.Effect<Exit.Exit<ChatSendReceipt, ChatMessageFailure>> =>
                    Exit.isFailure(exit)
                      ? Effect.succeed(Exit.failCause(exit.cause))
                      : Effect.exit(
                          launchStarted(
                            exit.value.input,
                            exit.value.assistantMessageId,
                            exit.value.started
                          )
                        )
                )
              })
            )
          )
        })

        const detachedRun = makeDetachedRun({
          runServices,
          runs,
          chatRunner,
          toolHost: () => toolHost
        })

        const startAutomation = makeStartAutomation({
          store,
          lifecycle,
          accepting,
          chatRunner,
          launchStarted
        })

        const continueTask = (input: TaskContinuationInput): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (chatRunner.current() === undefined) return
            const step = yield* workStore.nextInChat(
              "itemId" in input ? { itemId: input.itemId } : { sessionId: input.sessionId }
            )
            if (step === undefined) return
            const handedOn =
              "itemId" in input
                ? { sourceId: input.sourceId }
                : { sourceId: input.afterRunId, afterRunId: input.afterRunId }
            const chatMode = step.approvalMode
            yield* send(
              taskContinuation({
                sessionId: step.sessionId,
                ...handedOn,
                itemId: step.itemId,
                text: step.text,
                approvalMode:
                  input.approvalMode ?? (isApprovalMode(chatMode) ? chatMode : undefined)
              })
            ).pipe(
              Effect.asVoid,
              Effect.catchTag("ChatMessageConflictError", (error) =>
                error.kind === "session_busy" || error.kind === "task_idle"
                  ? Effect.void
                  : Effect.fail(error)
              )
            )
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Could not continue the chat's Task", { ...input, cause })
            )
          )

        const cancel = Effect.fn("ChatMessage.cancel")(function* (input: RunCancelTarget) {
          const cancelled = yield* requestCancellation(input)
          return {
            status: "cancelling",
            runId: cancelled.runId,
            cancelRequested: true
          } satisfies CancelResponse
        })

        const resolveTool = makeResolveTool({
          store,
          toolStore,
          fibers,
          lifecycle,
          chatRunner,
          launch
        })

        const toolHost: ToolHost = {
          lifecycle,
          launch,
          cancelAgent,
          sendMessage: send,
          detachedRun: (input) => detachedRun(input),
          draining: () => draining || !serverLifecycle.isAccepting(),
          heldBackground
        }

        const deliverBootArrivals = makeDeliverBootArrivals({ boot, send })
        const stopOlderSideApprovals = Effect.gen(function* () {
          const runIds = yield* store
            .sideRunsAwaitingApproval()
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not find older Side chat approvals", { cause }).pipe(
                  Effect.andThen(Effect.succeed<ReadonlyArray<string>>([]))
                )
              )
            )
          for (const runId of runIds) {
            yield* requestCancellation({ runId }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not stop older Side chat approval", { runId, cause })
              )
            )
          }
        })
        yield* serverLifecycle.background(
          Effect.gen(function* () {
            yield* stopOlderSideApprovals
            yield* deliverBootArrivals
            yield* startRunRecovery({
              beforeResume: deliverBootArrivals,
              lifecycle,
              launch,
              continueTask,
              runsEnded: (runIds) => stopHeldOfEndedRuns(heldBackground, runs, runIds),
              ownedRunIds: () => [...activeRuns.keys()],
              available: () => chatRunner.current() !== undefined,
              availability: chatRunner.availability,
              wake: limitSettings.changes
            })
            yield* Effect.never
          })
        )

        const drain = Effect.fn("ChatMessage.drain")(function* (input: {
          readonly toolSettleMs: number
          readonly budgetMs?: number
          readonly reason: StopReason
        }) {
          const deadline = performance.now() + (input.budgetMs ?? input.toolSettleMs + 4_000)
          const remaining = () => Math.max(0, deadline - performance.now())
          yield* serverLifecycle.quiesce
          yield* lifecycle
            .withPermit(
              Effect.sync(() => {
                draining = true
              })
            )
            .pipe(
              Effect.timeout(Math.max(1, remaining())),
              Effect.catchTag("TimeoutError", () =>
                Effect.logWarning("Chat admission did not settle before shutdown")
              )
            )
          draining = true
          const status = drainStatus(input.reason)
          const runIds = [...activeRuns.keys()]
          yield* Effect.forEach(
            runIds,
            (runId) => {
              const sessionId = activeRuns.get(runId)?.sessionId
              if (sessionId === undefined) return Effect.void
              return events
                .append({
                  sessionId,
                  events: [
                    {
                      event: {
                        type: "thinking",
                        run_id: runId,
                        session_id: sessionId,
                        status
                      },
                      runId
                    }
                  ]
                })
                .pipe(Effect.ignore)
            },
            { discard: true }
          ).pipe(Effect.timeout(Math.max(1, Math.min(250, remaining()))), Effect.ignore)
          const settleDeadline = Math.min(deadline, performance.now() + input.toolSettleMs)
          while (runIds.length > 0 && performance.now() < settleDeadline) {
            const running = yield* toolStore.runningCount(runIds).pipe(
              Effect.orElseSucceed(() => 0),
              Effect.timeout(Math.max(1, settleDeadline - performance.now())),
              Effect.orElseSucceed(() => 0)
            )
            if (running === 0) break
            yield* Effect.sleep(Math.min(100, Math.max(0, settleDeadline - performance.now())))
          }
          for (const { controller } of activeRuns.values()) controller.abort()
          heldBackground.stop()
          yield* FiberMap.awaitEmpty(fibers).pipe(
            Effect.timeout(Math.max(1, remaining() - 250)),
            Effect.catchCause((cause) =>
              Effect.logWarning("Chat runs did not settle before shutdown", { cause })
            )
          )
          yield* persistence.drain.pipe(
            Effect.timeout(Math.max(1, remaining())),
            Effect.catchTag("TimeoutError", () =>
              Effect.logWarning("Chat writes did not flush before shutdown")
            )
          )
        })

        return ChatMessage.of({
          runnerAvailability: chatRunner.availability,
          send,
          sendTogether,
          startAutomation,
          cancel,
          stopRuns,
          resolveTool,
          continueTask,
          detachedRun,
          drain
        })
      })
    )
  }
}
