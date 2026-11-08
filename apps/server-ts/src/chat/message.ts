import { boundAuthority } from "./run-authority.js"
import type {
  CancelInput,
  CancelResponse,
  ChatAcknowledgement,
  ChatReceipt,
  ToolResultInput
} from "@arden-hq/protocol/chat"
import { Persistence } from "../persistence/service.js"
import {
  Context,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Scope,
  Semaphore,
  type Stream
} from "effect"
import { randomUUID } from "node:crypto"
import { ChatEventStore } from "../persistence/events/store.js"
import { WorkStore } from "../persistence/work/store.js"
import { LimitSettingsStore } from "../persistence/settings/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { runPolicyOf } from "../execution/policy.js"
import {
  ChatWriteStore,
  type ChatWriteResume,
  type ChatWriteReceiveResult
} from "../persistence/chat/store.js"
import {
  ToolExecutionStore,
  type ApprovalAlternativeInput,
  type ApprovalEditsInput
} from "../persistence/tools/store.js"
import { TerminalSessions } from "../terminals/service.js"
import { stopRun } from "./run-stop.js"
import type { ServerToolRun } from "./runner-contract.js"
import { chatRunnerSource, type ChatRunnerOptions } from "./runner-source.js"
import { ModelProviderService } from "../models/provider.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { makeAgentRunScheduler } from "./agent-run-scheduler.js"
import { makePendingArrivals } from "./pending-arrivals.js"
import { isApprovalMode } from "@arden-hq/protocol/permissions"
import { makeDurableTools, type ToolHost } from "./durable-tools.js"
import { makeHeldBackground, stopHeldOfEndedRuns } from "./held-background.js"
import { makeHelperJobs } from "./helper-jobs.js"
import { startRunRecovery } from "./run-recovery.js"
import {
  runChat,
  type TaskContinuationInput,
  type RunHost,
  type RunServices
} from "./run-driver.js"
import {
  ChatMessageError,
  mapToolStoreError,
  mapWriteError,
  type ChatMessageFailure
} from "./message-errors.js"
import {
  automationRequestHash,
  taskContinuation,
  makeAutomationMessage,
  makeUserMessage,
  receipt,
  requestHash,
  validateInput,
  type ChatAutomationStartInput,
  type ChatSendInput
} from "./message-input.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"

export interface ChatMessageShape {
  readonly runnerAvailability: Stream.Stream<boolean>
  readonly send: (input: ChatSendInput) => Effect.Effect<ChatReceipt, ChatMessageFailure>
  readonly sendTogether: (
    inputs: ReadonlyArray<ChatSendInput>
  ) => Effect.Effect<ReadonlyArray<Exit.Exit<ChatReceipt, ChatMessageFailure>>>
  readonly startAutomation: (
    input: ChatAutomationStartInput
  ) => Effect.Effect<ChatReceipt, ChatMessageFailure>
  readonly cancel: (input: CancelInput) => Effect.Effect<CancelResponse, ChatMessageFailure>
  readonly stopRuns: (runIds: ReadonlyArray<string>) => Effect.Effect<void, ChatMessageFailure>
  readonly resolveTool: (
    input: Omit<ToolResultInput, "alternative"> & {
      readonly edits?: ApprovalEditsInput
      readonly alternative?: ApprovalAlternativeInput
    }
  ) => Effect.Effect<ChatAcknowledgement, ChatMessageFailure>
  readonly continueTask: (input: TaskContinuationInput) => Effect.Effect<void>
  readonly detachedRun: (input: {
    readonly sessionId: string
    readonly runId: string
  }) => Effect.Effect<ServerToolRun, ChatMessageError>
  readonly drain: (input: {
    readonly toolSettleMs: number
    readonly budgetMs?: number
    readonly reason: StopReason
  }) => Effect.Effect<void>
}

export type StopReason = "quit" | "restart"

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

        const requestCancellation = (input: CancelInput) =>
          stopRun({ store, cancelAgent }, input, fenceAndAbort(input))

        const fenceAndAbort = Effect.fn("ChatMessage.fenceAndAbort")(function* (
          input: CancelInput
        ) {
          return yield* Effect.uninterruptible(
            lifecycle.withPermit(
              Effect.gen(function* () {
                const cancelled = yield* store.cancel(input).pipe(Effect.mapError(mapWriteError))
                terminals.stopRuns([cancelled.runId, ...cancelled.descendantRunIds])
                yield* stopHeldOfEndedRuns(heldBackground, runs, [
                  cancelled.runId,
                  ...cancelled.descendantRunIds
                ])
                for (const runId of [cancelled.runId, ...cancelled.descendantRunIds]) {
                  activeRuns.get(runId)?.controller.abort()
                  activeRuns.delete(runId)
                  yield* Effect.forkIn(FiberMap.remove(fibers, runId), serverScope)
                }
                for (const runId of cancelled.descendantRunIds) {
                  yield* store.cancel({ runId }).pipe(
                    Effect.catch((cause) =>
                      cause._tag === "ChatWriteError" && cause.reason === "not_found"
                        ? Effect.void
                        : Effect.logWarning("Descendant cancellation remains pending", {
                            runId,
                            cause
                          })
                    )
                  )
                }
                return cancelled
              })
            )
          )
        })

        const cancelAgent: (input: {
          readonly runId: string
        }) => Effect.Effect<void, ChatMessageFailure> = Effect.fn("ChatMessage.cancelAgent")(
          function* (input: { readonly runId: string }) {
            yield* requestCancellation(input).pipe(
              Effect.catch((error) =>
                error instanceof ChatMessageError && error.reason === "not_found"
                  ? Effect.void
                  : Effect.fail(error)
              ),
              Effect.asVoid
            )
          }
        )

        const stopRuns = Effect.fn("ChatMessage.stopRuns")(function* (
          runIds: ReadonlyArray<string>
        ) {
          for (const runId of runIds) yield* cancelAgent({ runId })
          heldBackground.stop(runIds)
          terminals.stopRuns(runIds)
        })

        const launch = (run: ChatWriteResume): Effect.Effect<void> => {
          const runner = chatRunner.current()
          if (runner === undefined || draining || !serverLifecycle.isAccepting()) return Effect.void
          const host: RunHost = {
            ...toolHost,
            runner,
            planReading: () => modelProvider.current()?.planLimits?.latest(),
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
        ): Effect.Effect<ChatReceipt, ChatMessageFailure> => {
          const start = (): Effect.Effect<ChatReceipt> => {
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

        const prepare = Effect.fn("ChatMessage.prepare")(function* (
          input: ChatSendInput,
          admittedWith?: ReadonlyArray<string>
        ) {
          yield* validateInput(input)
          if (chatRunner.current() === undefined) {
            return yield* new ChatMessageError({
              reason: "unavailable",
              message: "Chat model runner is not configured"
            })
          }
          yield* workStore.stopSpent({ sessionId: input.sessionId }).pipe(
            Effect.mapError(
              (cause) =>
                new ChatMessageError({
                  reason: "storage",
                  message: "Could not check the chat's Task budget",
                  sessionId: input.sessionId,
                  cause
                })
            )
          )
          const message = yield* makeUserMessage(input)
          const assistantMessageId = randomUUID()
          const commit = yield* store
            .prepareReceive({
              sessionId: input.sessionId,
              clientId: input.clientId,
              requestHash: requestHash(input),
              assistantMessageId,
              message,
              ...(input.approvalReply === undefined ? {} : { approvalReply: input.approvalReply }),
              wake: input.wake ?? true,
              ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
              ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
              ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
              ...(admittedWith === undefined ? {} : { admittedWith }),
              ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
              ...(input.modelRole === undefined ? {} : { modelRole: input.modelRole }),
              ...(input.announce === undefined ? {} : { announce: true }),
              ...(input.fromQueue === undefined ? {} : { fromQueue: true }),
              ...(input.continuesTask === undefined ? {} : { continuesTask: input.continuesTask }),
              ...(input.capture === undefined
                ? {}
                : {
                    capture: {
                      via: input.capture,
                      note: input.message,
                      screenshot: (input.images?.length ?? 0) > 0
                    }
                  })
            })
            .pipe(Effect.mapError(mapWriteError))
          return commit.pipe(
            Effect.mapError(mapWriteError),
            Effect.tap(() => scheduleNaming(input)),
            Effect.map((started) => ({ input, assistantMessageId, started }))
          )
        })

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
                  (exit): Effect.Effect<Exit.Exit<ChatReceipt, ChatMessageFailure>> =>
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

        const detachedRun = Effect.fn("ChatMessage.detachedRun")(function* (input: {
          readonly sessionId: string
          readonly runId: string
        }) {
          if (chatRunner.current() === undefined) {
            return yield* new ChatMessageError({
              reason: "unavailable",
              message: "Chat model runner is not configured",
              sessionId: input.sessionId
            })
          }
          const policy = yield* runs.get(input.runId).pipe(
            Effect.flatMap(runPolicyOf),
            Effect.mapError(
              (cause) =>
                new ChatMessageError({
                  reason: "unavailable",
                  message: "The Run's captured policy is unavailable",
                  sessionId: input.sessionId,
                  cause
                })
            )
          )
          const tools = yield* makeDurableTools(toolHost, {
            sessionId: input.sessionId,
            runId: input.runId,
            signal: AbortSignal.any([]),
            eventSequence: { value: undefined }
          }).pipe(Effect.provideContext(runServices))
          const authority = yield* boundAuthority(runs, input)
          return {
            sessionId: input.sessionId,
            runId: input.runId,
            policy,
            authority,
            approvalMode: "ask",
            executeTool: tools.execute,
            executeDetachedTool: tools.executeDetached,
            spawnAgent: tools.spawnAgent,
            cancelAgent: tools.cancelAgent,
            sendMessage: tools.sendMessage,
            detachedRun: tools.detachedRun,
            emitToolProgress: tools.emitToolProgress,
            emitToolOutput: tools.emitToolOutput,
            declareEffectTarget: tools.declareEffectTarget
          } satisfies ServerToolRun
        })

        const startAutomation = Effect.fn("ChatMessage.startAutomation")(function* (
          input: ChatAutomationStartInput
        ) {
          if (input.prompt.trim().length === 0) {
            return yield* new ChatMessageError({
              reason: "invalid",
              message: "An Automation requires a prompt",
              sessionId: input.sessionId
            })
          }
          if (chatRunner.current() === undefined) {
            return yield* new ChatMessageError({
              reason: "unavailable",
              message: "Chat model runner is not configured"
            })
          }

          const message = yield* makeAutomationMessage(input)
          const assistantMessageId = randomUUID()
          const commit = yield* store
            .prepareReceive({
              sessionId: input.sessionId,
              clientId: input.clientId,
              requestHash: automationRequestHash(input),
              assistantMessageId,
              message,
              wake: true,
              approvalMode: "ask",
              automation: input.automation,
              automationContextMode: input.contextMode,
              automationLease: input.lease,
              ...(input.handlerItem === undefined ? {} : { handlerItem: input.handlerItem }),
              automationPrompt: input.prompt,
              ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
              ...(input.modelRole === undefined ? {} : { modelRole: input.modelRole })
            })
            .pipe(Effect.mapError(mapWriteError))
          return yield* Effect.uninterruptible(
            lifecycle.withPermit(
              Effect.gen(function* () {
                yield* accepting
                const started = yield* commit.pipe(Effect.mapError(mapWriteError))
                return yield* launchStarted(input, assistantMessageId, started)
              })
            )
          )
        })

        const continueTask = (input: TaskContinuationInput): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (chatRunner.current() === undefined) return
            const step = yield* workStore.nextInChat(
              "itemId" in input ? { itemId: input.itemId } : { sessionId: input.sessionId }
            )
            if (step === undefined) return
            const chatMode = step.approvalMode
            yield* send(
              taskContinuation({
                sessionId: step.sessionId,
                sourceId: input.sourceId,
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

        const cancel = Effect.fn("ChatMessage.cancel")(function* (input: CancelInput) {
          const cancelled = yield* requestCancellation(input)
          return {
            status: "cancelling",
            runId: cancelled.runId,
            cancelRequested: true
          } satisfies CancelResponse
        })

        const resolveTool = Effect.fn("ChatMessage.resolveTool")(function* (
          input: Omit<ToolResultInput, "alternative"> & {
            readonly edits?: ApprovalEditsInput
            readonly alternative?: ApprovalAlternativeInput
          }
        ) {
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const active = yield* FiberMap.get(fibers, input.runId)
              if (Option.isSome(active)) yield* Fiber.await(active.value)
              return yield* lifecycle.withPermit(
                Effect.gen(function* () {
                  const resolution = yield* toolStore
                    .resolve({
                      runId: input.runId,
                      toolCallId: input.toolId,
                      feedback: input.result,
                      ...(input.approved === undefined ? {} : { approved: input.approved }),
                      ...(input.grantStanding === undefined
                        ? {}
                        : { grantStanding: input.grantStanding }),
                      ...(input.grantList === undefined ? {} : { grantList: input.grantList }),
                      ...(input.attachFolderToSpace === undefined
                        ? {}
                        : { attachFolderToSpace: input.attachFolderToSpace }),
                      ...(input.edits === undefined ? {} : { edits: input.edits }),
                      ...(input.alternative === undefined ? {} : { alternative: input.alternative })
                    })
                    .pipe(Effect.mapError(mapToolStoreError))
                  if (resolution.ready && chatRunner.current() !== undefined) {
                    const claimed = yield* store
                      .claimResume(resolution.runId)
                      .pipe(Effect.mapError(mapWriteError))
                    if (claimed !== null) yield* launch(claimed)
                  }
                  return { status: "ok" } satisfies ChatAcknowledgement
                })
              )
            })
          )
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

        const pendingBootArrivals = new Map(
          (boot.arrivals?.() ?? []).map((arrival) => [
            JSON.stringify([arrival.sessionId, arrival.clientId]),
            arrival
          ])
        )
        const deliverBootArrivals = Effect.gen(function* () {
          for (const arrival of pendingBootArrivals.values()) {
            yield* send(arrival).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  boot.acknowledgeArrival?.(arrival)
                  pendingBootArrivals.delete(JSON.stringify([arrival.sessionId, arrival.clientId]))
                })
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not deliver a message left by the last shutdown", {
                  sessionId: arrival.sessionId,
                  cause
                })
              )
            )
          }
        })
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
