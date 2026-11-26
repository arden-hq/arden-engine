import { ROLE } from "@arden-hq/std/message-vocabulary"
import { ContextExperiments } from "../context/experiments.js"
import { TOOL_KIND, TOOL_PRESENTATION } from "@arden-hq/protocol/chat"
import type { StoredRunTerminalResult } from "../persistence/runs/stored-result.js"
import { tokenUsageEvent } from "./token-usage-event.js"
import {
  AGENT_EVENT_TAG,
  HISTORY_CHANGE_KIND,
  StopReason,
  type AgentEvent,
  type Result as LoopResult
} from "@arden-hq/loop"
import { Cause, Effect, Schema, Stream } from "effect"
import { ChatEventStore } from "../persistence/events/store.js"
import { WorkStore } from "../persistence/work/store.js"
import {
  ChatWriteStore,
  CHAT_WRITE_FINISH,
  MODEL_ADMISSION,
  type ModelAdmission,
  type ChatCheckpointAnchor
} from "../persistence/chat/store.js"
import {
  answerFixInHistory,
  makeLoopEventMapper,
  terminalTextAnchor,
  type ChatEventBatch
} from "./loop-events.js"
import { makeCheckpointGate } from "./checkpoint-gate.js"
import { makeResultHistoryProjector } from "./result-history.js"
import { advanceEventSequence, makeDurableTools, whileRunActive } from "./durable-tools.js"
import { ChatMessageError, mapWriteError } from "./message-errors.js"
import { isPublicActivityTool } from "@arden-hq/protocol/views"
import { makeRunPurposeObserver, type RunPurposeObserver } from "./run-purpose-observer.js"
import { Diagnostics } from "../runtime/diagnostics.js"
import {
  type ChatRun,
  type RunHost,
  type RunServices,
  accumulateRunTotals,
  appendEventBatches,
  finishWithFailure,
  historyError,
  isAgentEvent,
  pausedRunFailure,
  runTotalsUsage,
  runnerError,
  toChatRunnerMessages,
  toRunModelMessages
} from "./run-driver-support.js"

export const runChat = Effect.fn("ChatMessage.runChat")(function* (
  host: RunHost,
  input: ChatRun
): Effect.fn.Return<void, unknown, RunServices> {
  const store = yield* ChatWriteStore
  const events = yield* ChatEventStore
  const tasks = yield* WorkStore
  const experiments = yield* ContextExperiments
  const diagnostics = yield* Diagnostics
  const services = yield* Effect.context<never>()
  const runPromise = Effect.runPromiseWith(services)
  const tools = yield* makeDurableTools(host, input)
  let observedResult: StoredRunTerminalResult | undefined
  let quotaPause: ModelAdmission | undefined
  let purpose: RunPurposeObserver | undefined
  const work = Effect.gen(function* () {
    const mapper = makeLoopEventMapper(
      input.assistantMessageId,
      input.runId,
      answerFixInHistory(input.storedMessages, new Set(input.mintedMessageIds))
    )
    const projector = makeResultHistoryProjector({
      initialMessages: input.storedMessages,
      assistantMessageId: input.assistantMessageId,
      assistantMessagePersisted: input.mintedMessageIds.includes(input.assistantMessageId),
      terminalMessageId: `${input.runId}:terminal`,
      automationContextMode: input.automationContextMode,
      turnId: input.turnId
    })
    const checkpointGate = makeCheckpointGate()
    let checkpointAnchor: ChatCheckpointAnchor | undefined
    let appendReady = false
    const runnerMessages = yield* toRunModelMessages({
      sessionId: input.sessionId,
      activeMessages: input.storedMessages,
      automationContextMode: input.automationContextMode,
      turnId: input.turnId
    })
    const treeRootSessionId = yield* store
      .sessionTreeRoot(input.sessionId)
      .pipe(Effect.orElseSucceed(() => input.sessionId))
    purpose = makeRunPurposeObserver({
      run: input,
      turnId: input.turnId,
      messages: runnerMessages,
      launch: (request, settled) => {
        void runPromise(host.scheduleRunPurpose({ ...request, settled })).catch(() => settled())
      }
    })
    let loopResult: LoopResult | undefined
    const iterable = yield* Effect.try({
      try: () =>
        host.runner({
          reportModelTiming: (timing) => {
            experiments.phase(input.runId, timing)
            void runPromise(
              diagnostics.operational({
                ...timing,
                code: "chat.model_phase",
                severity: "info",
                runId: input.runId,
                sessionId: input.sessionId
              })
            ).catch(() => {})
          },
          sessionId: input.sessionId,
          treeRootSessionId,
          runId: input.runId,
          turnId: input.turnId,
          assistantMessageId: input.assistantMessageId,
          mintedMessageIds: input.mintedMessageIds,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          approvalMode: input.approvalMode,
          outputSchema: input.outputSchema,
          automationId: input.automation?.automationId ?? null,
          messages: runnerMessages,
          executionBudget: () => runPromise(store.executionBudget(input.runId)),
          admitModelRequest: async (sampleId) => {
            if (host.draining()) throw new Error("Draining for a restart")
            const admission = await runPromise(
              store.admitModelRequest(
                input.runId,
                sampleId,
                input.model === null ? undefined : host.planReading(input.model)
              )
            )
            if (admission.kind === MODEL_ADMISSION.paused) {
              quotaPause = admission
              throw new Error(`Paused on a plan limit until ${admission.until}`)
            }
            purpose?.begin()
          },
          recordModelUsage: (sample) =>
            runPromise(
              store
                .recordModelUsage({
                  runId: input.runId,
                  ...sample
                })
                .pipe(Effect.andThen(tasks.stopSpent({ runId: input.runId })))
            ),
          waitForPendingMessages: (signal) => host.waitForPendingMessages(input.runId, signal),
          peekPendingInput: () => runPromise(store.peekPendingInput(input.runId)),
          getPendingMessages: () =>
            runPromise(
              host.lifecycle.withPermit(
                Effect.suspend(() =>
                  input.signal.aborted
                    ? Effect.succeed([])
                    : store.drainPending(input.runId).pipe(
                        Effect.mapError(mapWriteError),
                        Effect.flatMap((pending) => toChatRunnerMessages(input.sessionId, pending)),
                        Effect.tap((pending) =>
                          Effect.sync(() => {
                            if (pending.length === 0) return
                            purpose?.steer(pending)
                          })
                        )
                      )
                )
              )
            ),
          checkpointMessages: (messages, context, completionMessageId, change) => {
            purpose?.checkpoint([...messages])
            const incremental =
              change?.kind === HISTORY_CHANGE_KIND.append &&
              appendReady &&
              checkpointAnchor !== undefined
            const snapshot =
              change?.kind === HISTORY_CHANGE_KIND.replace || incremental
                ? change.messages
                : [...messages]
            const anchor = incremental ? checkpointAnchor : undefined
            const done = checkpointGate(
              {
                messages: snapshot,
                ...(change === undefined ? {} : { revision: change.revision }),
                context,
                completionMessageId,
                eventSequence: input.eventSequence.value
              },
              () =>
                runPromise(
                  Effect.suspend(() => {
                    if (input.signal.aborted) return Effect.interrupt
                    if (incremental) return projector.checkpointAppend(change)
                    return projector.checkpoint(snapshot).pipe(
                      Effect.map((projected) => ({
                        messages: projected,
                        count: projected.length
                      }))
                    )
                  }).pipe(
                    Effect.mapError((error) => historyError(input, error)),
                    Effect.flatMap((projected) =>
                      whileRunActive(
                        host,
                        input,
                        Effect.suspend(() => {
                          const eventSequence = input.eventSequence.value
                          return store
                            .checkpoint({
                              runId: input.runId,
                              messages: projected.messages,
                              ...(anchor === undefined ? {} : { appendFrom: anchor }),
                              ...(completionMessageId === undefined ? {} : { completionMessageId }),
                              ...(eventSequence === undefined ? {} : { eventSequence }),
                              ...(context === undefined
                                ? {}
                                : { lastInputTokens: context.inputTokens })
                            })
                            .pipe(
                              Effect.mapError(mapWriteError),
                              Effect.flatMap((persistedAnchor) =>
                                context === undefined
                                  ? Effect.succeed({ covered: eventSequence, persistedAnchor })
                                  : events
                                      .append({
                                        sessionId: input.sessionId,
                                        events: [
                                          {
                                            event: tokenUsageEvent(input, context, projected.count),
                                            runId: input.runId
                                          }
                                        ]
                                      })
                                      .pipe(
                                        Effect.map((committed) => {
                                          advanceEventSequence(input, committed)
                                          const covered =
                                            committed.headSequence === (eventSequence ?? 0) + 1
                                              ? committed.headSequence
                                              : eventSequence
                                          return { covered, persistedAnchor }
                                        })
                                      )
                              )
                            )
                        })
                      )
                    )
                  )
                ).then(({ covered, persistedAnchor }) => {
                  checkpointAnchor = persistedAnchor
                  appendReady = true
                  return covered
                })
            )
            return done.catch((cause: unknown) => {
              appendReady = false
              throw cause
            })
          },
          tools,
          signal: input.signal
        }),
      catch: (cause) =>
        new ChatMessageError({
          reason: "runner",
          message: "Chat runner failed to start",
          sessionId: input.sessionId,
          cause
        })
    })

    yield* Stream.fromAsyncIterable(
      iterable,
      (cause) =>
        new ChatMessageError({
          reason: "runner",
          message: "Chat runner failed while streaming",
          sessionId: input.sessionId,
          cause
        })
    ).pipe(
      Stream.groupedWithin(64, "16 millis"),
      Stream.runForEach(
        Effect.fn("ChatMessage.publishOutputs")(function* (
          outputs: ReadonlyArray<AgentEvent | LoopResult>
        ) {
          const batches: ChatEventBatch[] = []
          for (const output of outputs) {
            if (loopResult !== undefined) {
              return yield* new ChatMessageError({
                reason: "runner",
                message: "Chat runner emitted output after its terminal result",
                sessionId: input.sessionId
              })
            }
            if (typeof output !== "object" || output === null) {
              return yield* runnerError(input, "Chat runner emitted an unstructured value")
            }
            if (isAgentEvent(output)) {
              batches.push(...mapper.map(output))
              if (
                output._tag === AGENT_EVENT_TAG.toolStarted &&
                !output.parent_id &&
                output.host.presentation !== TOOL_PRESENTATION.conversation &&
                (output.host.kind === TOOL_KIND.agent ||
                  isPublicActivityTool(
                    output.name,
                    output.host.presentation === TOOL_PRESENTATION.status
                      ? TOOL_PRESENTATION.status
                      : undefined
                  ))
              )
                purpose?.work(output)
            } else {
              loopResult = output
            }
          }
          yield* appendEventBatches(host, input, batches)
        })
      )
    )

    if (loopResult === undefined) {
      return yield* runnerError(input, "Structured Chat runner ended without a terminal result")
    }
    const result = loopResult
    if (result.stop_reason === StopReason.PAUSED) {
      const reasons = new Set(result.paused_tools.map((tool) => tool.reason))
      const failure = pausedRunFailure(reasons)
      if (failure !== undefined) {
        yield* whileRunActive(
          host,
          input,
          store.fail({ runId: input.runId, ...failure }).pipe(Effect.mapError(mapWriteError))
        )
      }
      return
    }

    const messages = yield* projector.result(result)
    const terminalMessage = [...messages]
      .reverse()
      .find((message) => message.role === ROLE.assistant)
    const terminalTextId = terminalTextAnchor(messages)
    const totals = accumulateRunTotals(input.totals, result)
    const usage = runTotalsUsage(totals)
    const structuredData =
      result.object === undefined
        ? null
        : yield* Schema.decodeUnknownEffect(Schema.Json)(result.object)
    const terminalResult = {
      text: result.text,
      data: structuredData,
      usage,
      ...(totals.cost === undefined ? {} : { cost: totals.cost }),
      duration_ms: totals.durationMs,
      tool_time_ms: totals.toolTimeMs,
      steps: totals.steps,
      last_input_tokens: result.last_input_tokens
    } satisfies StoredRunTerminalResult
    observedResult = terminalResult
    yield* appendEventBatches(host, input, mapper.finalText(terminalTextId, result.text))
    const terminal = yield* whileRunActive(
      host,
      input,
      Effect.gen(function* () {
        yield* store.checkpoint({
          runId: input.runId,
          messages,
          ...(input.eventSequence.value === undefined
            ? {}
            : { eventSequence: input.eventSequence.value })
        })
        return yield* store.finish({
          runId: input.runId,
          messages,
          result: terminalResult,
          stopReason: result.stop_reason,
          usage,
          lastInputTokens: result.last_input_tokens,
          terminalTextEnded: mapper.hasEnded(terminalTextId),
          supersededMessageIds: mapper.superseded({
            stopReason: result.stop_reason,
            terminalTextId,
            text: result.text
          })
        })
      }).pipe(Effect.mapError(mapWriteError))
    )
    purpose?.stop()
    if (terminal._tag === CHAT_WRITE_FINISH.continued) {
      input.eventSequence.value = terminal.eventSequence
      if (typeof terminalMessage?.message_id === "string") {
        yield* host.scheduleLetterSubject(input.sessionId, {
          messageId: terminalMessage.message_id,
          text: result.text
        })
      }
      return yield* runChat(host, {
        ...input,
        storedMessages: terminal.activeMessages,
        assistantMessageId: terminal.assistantMessageId,
        mintedMessageIds: [],
        totals
      })
    }
    if (typeof terminalMessage?.message_id === "string") {
      yield* host.scheduleLetterSubject(input.sessionId, {
        messageId: terminalMessage.message_id,
        text: result.text
      })
    }
    if (input.automation === null) {
      yield* host.continueTask({
        sessionId: input.sessionId,
        afterRunId: input.runId,
        approvalMode: input.approvalMode
      })
    }
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      if (host.draining()) return Effect.void
      if (quotaPause !== undefined) return Effect.void
      return finishWithFailure(host, input, cause)
    })
  )

  return yield* work.pipe(
    Effect.ensuring(Effect.sync(() => experiments.finish(input.runId))),
    Effect.ensuring(Effect.sync(() => purpose?.stop())),
    Effect.ensuring(
      Effect.suspend(() =>
        input.signal.aborted && observedResult !== undefined && !host.draining()
          ? host.lifecycle
              .withPermit(store.recordLateOutcome({ runId: input.runId, result: observedResult }))
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Could not retain the cancelled Run's observed result", {
                    runId: input.runId,
                    cause
                  })
                )
              )
          : Effect.void
      )
    ),
    Effect.ensuring(
      tasks.stopSpent({ runId: input.runId }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not check the Run's Task budget", {
            runId: input.runId,
            cause
          })
        )
      )
    )
  )
})
