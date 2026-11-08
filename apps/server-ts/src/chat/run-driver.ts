import { ContextExperiments } from "../context/experiments.js"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import type { ChatApprovalMode, ChatRunErrorCode } from "@arden-hq/protocol/chat"
import type { JsonObject } from "../persistence/json.js"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import type { RunTerminalResult } from "@arden-hq/protocol/runs"
import { decodeMessage, providerErrorCode } from "@arden-hq/loop"
import type { AgentEvent, Result as LoopResult } from "@arden-hq/loop"
import { Cause, Effect, Result, Schema, Stream } from "effect"
import { ChatEventStore } from "../persistence/events/store.js"
import { WorkStore } from "../persistence/work/store.js"
import {
  ChatWriteStore,
  type ChatAutomationOrigin,
  type ChatWriteResume,
  type ModelAdmission,
  type ChatCheckpointAnchor
} from "../persistence/chat/store.js"
import type { PlanReading } from "../models/plan-limits.js"
import {
  TOOL_MUTATION_STALLED,
  TOOL_PERSISTENCE_FAILED,
  type ToolExecutionStore
} from "../persistence/tools/store.js"
import type { StoredMessageEnvelope } from "../persistence/transcript/model.js"
import type { ChatRunner, ChatRunnerMessage } from "./runner-contract.js"
import {
  coalesceEventBatches,
  answerFixInHistory,
  makeLoopEventMapper,
  terminalTextAnchor,
  type ChatEventBatch
} from "./loop-events.js"
import { makeCheckpointGate } from "./checkpoint-gate.js"
import { makeResultHistoryProjector, type ResultHistoryError } from "./result-history.js"
import { isRunAlreadyTerminal, persistRunTerminal } from "./terminal-write.js"
import {
  advanceEventSequence,
  makeDurableTools,
  whileRunActive,
  type ToolHost,
  type ToolRun
} from "./durable-tools.js"
import { ChatMessageError, mapWriteError, StoredMessageDecodeError } from "./message-errors.js"
import { isPublicActivityTool } from "@arden-hq/protocol/views"
import type { HelperJobs } from "./helper-jobs.js"
import { makeRunPurposeObserver, type RunPurposeObserver } from "./run-purpose-observer.js"
import { Diagnostics } from "../runtime/diagnostics.js"

export type TaskContinuationInput = {
  readonly approvalMode?: ChatApprovalMode
  readonly sourceId: string
} & ({ readonly sessionId: string } | { readonly itemId: string })

export interface RunHost extends ToolHost {
  readonly scheduleRunPurpose: HelperJobs["scheduleRunPurpose"]
  readonly runner: ChatRunner
  readonly planReading: () => PlanReading | undefined
  readonly continueTask: (input: TaskContinuationInput) => Effect.Effect<void>
  readonly scheduleLetterSubject: (
    sessionId: string,
    input: { readonly messageId: string; readonly text: string }
  ) => Effect.Effect<void>
  readonly waitForPendingMessages: (runId: string, signal: AbortSignal) => Promise<void>
}

interface RunTotals {
  readonly prompt: number
  readonly completion: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number
  readonly durationMs: number
  readonly toolTimeMs: number
  readonly steps: number
}

export interface ChatRun extends ToolRun {
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly approvalMode: ChatApprovalMode
  readonly outputSchema: JsonObject | null
  readonly automation: ChatAutomationOrigin | null
  readonly automationContextMode: AutomationContextMode | null
  readonly turnId: string
  readonly storedMessages: ReadonlyArray<StoredMessageEnvelope>
  readonly assistantMessageId: string
  readonly mintedMessageIds: ReadonlyArray<string>
  readonly totals?: RunTotals
}

export type RunServices = ChatWriteStore | ChatEventStore | ToolExecutionStore | WorkStore

const pausedRunFailure = (
  reasons: ReadonlySet<string>
): { readonly code: ChatRunErrorCode; readonly message: string } | undefined => {
  if (reasons.has(TOOL_PERSISTENCE_FAILED)) {
    return {
      code: TOOL_PERSISTENCE_FAILED,
      message: "Durable tool execution state could not be recorded"
    }
  }
  if (reasons.has(TOOL_MUTATION_STALLED)) {
    return {
      code: "runner_error",
      message: "An earlier change in this run was approved but never ran"
    }
  }
  return undefined
}

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
  let observedResult: RunTerminalResult | undefined
  let quotaPause: ModelAdmission | undefined
  let purpose: RunPurposeObserver | undefined
  const work = Effect.gen(function* () {
    const mapper = makeLoopEventMapper(
      input.assistantMessageId,
      input.runId,
      answerFixInHistory(input.storedMessages, input.assistantMessageId)
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
                cause: null,
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
              store.admitModelRequest(input.runId, sampleId, host.planReading())
            )
            if (admission.kind === "paused") {
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
              change?.kind === "append" && appendReady && checkpointAnchor !== undefined
            const snapshot =
              change?.kind === "replace" || incremental ? change.messages : [...messages]
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
                                            event: {
                                              type: "token_usage",
                                              run_id: input.runId,
                                              session_id: input.sessionId,
                                              scope: "run",
                                              usage: context.usage,
                                              context_input_tokens: context.inputTokens,
                                              message_count: projected.count
                                            } satisfies ChatProjectionEvent,
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
                output._tag === "ToolStarted" &&
                !output.parent_id &&
                output.host.presentation !== "conversation" &&
                (output.host.kind === "agent" ||
                  isPublicActivityTool({
                    name: output.name,
                    presentation: output.host.presentation === "status" ? "status" : undefined
                  }))
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
    if (result.stop_reason === "paused") {
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
    const terminalMessage = [...messages].reverse().find((message) => message.role === "assistant")
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
      usage: {
        prompt: totals.prompt,
        completion: totals.completion,
        total: usage.total,
        cache_read: totals.cacheRead,
        cache_write: totals.cacheWrite
      },
      cost: totals.cost,
      duration_ms: totals.durationMs,
      tool_time_ms: totals.toolTimeMs,
      steps: totals.steps,
      last_input_tokens: result.last_input_tokens
    } satisfies RunTerminalResult
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
          captureMemory: true,
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
    if (terminal._tag === "Continued") {
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
        sourceId: input.runId,
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

export const toChatRunnerMessages = (
  sessionId: string,
  messages: ReadonlyArray<StoredMessageEnvelope>
): Effect.Effect<ReadonlyArray<ChatRunnerMessage>, StoredMessageDecodeError> =>
  Effect.forEach(messages, (message, index) =>
    Effect.try({
      try: () => decodeMessage({ ...message }),
      catch: (error) => {
        const position = index + 1
        return new StoredMessageDecodeError({
          sessionId,
          messageId: message.message_id,
          position,
          message:
            `Stored message #${position} (${message.message_id}) in session ${sessionId} ` +
            `is not a valid chat message: ${decodeFailureDetail(error)}`
        })
      }
    })
  )

const decodeFailureDetail = (error: unknown): string =>
  error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error)

const toRunModelMessages = (
  input: Pick<ChatWriteResume, "sessionId" | "activeMessages" | "automationContextMode" | "turnId">
): Effect.Effect<ReadonlyArray<ChatRunnerMessage>, StoredMessageDecodeError> => {
  if (input.automationContextMode !== "fresh") {
    return toChatRunnerMessages(input.sessionId, input.activeMessages)
  }
  const currentTurn = input.activeMessages.filter((message) => message.turn_id === input.turnId)
  if (currentTurn.length === 0) {
    return Effect.die(new Error("Fresh Automation run has no durable current-turn messages"))
  }
  return toChatRunnerMessages(input.sessionId, currentTurn)
}

const isAgentEvent = (output: AgentEvent | LoopResult): output is AgentEvent => "_tag" in output

const runnerError = (input: Pick<ChatRun, "sessionId">, message: string): ChatMessageError =>
  new ChatMessageError({
    reason: "runner",
    message,
    sessionId: input.sessionId
  })

const historyError = (
  input: Pick<ChatRun, "sessionId">,
  error: ResultHistoryError
): ChatMessageError =>
  new ChatMessageError({
    reason: "runner",
    message: error.message,
    sessionId: input.sessionId,
    ...(error.cause === undefined ? {} : { cause: error.cause })
  })

const appendEventBatches = Effect.fn("ChatMessage.appendEventBatches")(function* (
  host: RunHost,
  input: ChatRun,
  batches: ReadonlyArray<ChatEventBatch>
): Effect.fn.Return<void, unknown, ChatEventStore> {
  if (batches.length === 0) return
  const events = yield* ChatEventStore
  yield* whileRunActive(
    host,
    input,
    Effect.forEach(
      coalesceEventBatches(batches),
      (batch) =>
        events
          .append({
            sessionId: input.sessionId,
            events: batch.map((event) => ({ event, runId: input.runId }))
          })
          .pipe(
            Effect.tap((committed) =>
              Effect.sync(() => {
                input.eventSequence.value = committed.headSequence
              })
            )
          ),
      { discard: true }
    )
  )
})

const accumulateRunTotals = (previous: RunTotals | undefined, result: LoopResult): RunTotals => ({
  prompt: (previous?.prompt ?? 0) + result.usage.prompt_tokens,
  completion: (previous?.completion ?? 0) + result.usage.completion_tokens,
  cacheRead: (previous?.cacheRead ?? 0) + result.usage.cache_read_tokens,
  cacheWrite: (previous?.cacheWrite ?? 0) + result.usage.cache_write_tokens,
  cost: (previous?.cost ?? 0) + result.cost,
  durationMs: (previous?.durationMs ?? 0) + result.duration_ms,
  toolTimeMs: (previous?.toolTimeMs ?? 0) + result.tool_time_ms,
  steps: (previous?.steps ?? 0) + result.steps
})

const runTotalsUsage = (totals: RunTotals) => ({
  prompt: totals.prompt,
  completion: totals.completion,
  total: totals.prompt + totals.completion + totals.cacheRead + totals.cacheWrite,
  cache_read: totals.cacheRead,
  cache_write: totals.cacheWrite,
  cost: totals.cost
})

interface PersistedRunFailure {
  readonly code: ChatRunErrorCode
  readonly message: string
}

const CONTEXT_OVERFLOW_MESSAGE =
  "Your input exceeds this model's context window. Shorten the conversation or use a larger-context model."

const persistedRunFailure = (cause: Cause.Cause<unknown>): PersistedRunFailure => {
  const squashed = Cause.squash(cause)
  const chain: Array<Error> = []
  const seen = new Set<unknown>()
  let current: unknown = squashed
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = current.cause
  }

  const detail = [...chain].reverse().find((error) => error.message.trim().length > 0)
  const message = detail?.message.trim().slice(0, 2_000) || "The assistant run failed"
  const code = providerErrorCode(squashed) ?? "runner_error"
  return code === "context_length_exceeded"
    ? { code, message: CONTEXT_OVERFLOW_MESSAGE }
    : { code, message }
}

const ABORTED_WITHOUT_TERMINAL = "The assistant run stopped without finishing."

const confirmRunTerminal = Effect.fn("ChatMessage.confirmRunTerminal")(function* (
  input: Pick<ChatRun, "runId">
): Effect.fn.Return<void, never, ChatWriteStore> {
  const store = yield* ChatWriteStore
  const terminal = yield* persistRunTerminal(
    store.fail({
      runId: input.runId,
      code: "run_interrupted",
      message: ABORTED_WITHOUT_TERMINAL
    })
  )
  if (Result.isFailure(terminal)) {
    if (isRunAlreadyTerminal(terminal.failure)) return
    yield* Effect.logWarning("Could not close an aborted Chat run", {
      runId: input.runId,
      failure: terminal.failure
    })
    return
  }
  yield* Effect.logWarning("Closed an aborted Chat run that had no terminal write", {
    runId: input.runId
  })
})

const finishWithFailure = Effect.fn("ChatMessage.finishWithFailure")(function* (
  host: RunHost,
  input: ChatRun,
  cause: Cause.Cause<unknown>
): Effect.fn.Return<void, never, ChatWriteStore> {
  const store = yield* ChatWriteStore
  yield* host.lifecycle.withPermit(
    Effect.suspend(() =>
      input.signal.aborted
        ? confirmRunTerminal(input)
        : Effect.gen(function* () {
            yield* Effect.logError("Chat runner failed", cause)
            const failure = persistedRunFailure(cause)
            const terminal = yield* persistRunTerminal(
              store.fail({
                runId: input.runId,
                code: failure.code,
                message: failure.message
              })
            )
            if (Result.isFailure(terminal)) {
              if (isRunAlreadyTerminal(terminal.failure)) return undefined
              yield* Effect.logError("Could not persist failed chat run", terminal.failure)
              return undefined
            }
          })
    )
  )
})
