import { AUTOMATION_CONTEXT_MODE } from "@arden-hq/protocol/automations"
import { CHAT_RUN_ERROR_CODE } from "@arden-hq/protocol/chat"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import { type ChatApprovalMode, type ChatRunErrorCode } from "@arden-hq/protocol/chat"
import type { JsonObject } from "../persistence/json.js"
import type { StoredRunUsage } from "../persistence/runs/stored-result.js"
import { addCost, decodeMessage, providerErrorCode } from "@arden-hq/loop"
import type { AgentEvent, Result as LoopResult } from "@arden-hq/loop"
import { Cause, Effect, Result } from "effect"
import { ChatEventStore } from "../persistence/events/store.js"
import { WorkStore } from "../persistence/work/store.js"
import {
  ChatWriteStore,
  type ChatAutomationOrigin,
  type ChatWriteResume
} from "../persistence/chat/store.js"
import type { PlanReading } from "../models/plan-limits.js"
import {
  TOOL_MUTATION_STALLED,
  TOOL_PERSISTENCE_FAILED,
  type ToolExecutionStore
} from "../persistence/tools/store.js"
import type { StoredMessageEnvelope } from "../persistence/transcript/model.js"
import type { ChatRunner, ChatRunnerMessage } from "./runner-contract.js"
import { coalesceEventBatches, type ChatEventBatch } from "./loop-events.js"
import { type ResultHistoryError } from "./result-history.js"
import { isRunAlreadyTerminal, persistRunTerminal } from "./terminal-write.js"
import { whileRunActive, type ToolHost, type ToolRun } from "./durable-tools.js"
import { ChatMessageError, StoredMessageDecodeError } from "./message-errors.js"
import type { HelperJobs } from "./helper-jobs.js"

export type TaskContinuationInput = { readonly approvalMode?: ChatApprovalMode } & (
  | { readonly sessionId: string; readonly afterRunId: string }
  | { readonly itemId: string; readonly sourceId: string }
)

export interface RunHost extends ToolHost {
  readonly scheduleRunPurpose: HelperJobs["scheduleRunPurpose"]
  readonly runner: ChatRunner
  readonly planReading: (model: string) => PlanReading | undefined
  readonly continueTask: (input: TaskContinuationInput) => Effect.Effect<void>
  readonly scheduleLetterSubject: (
    sessionId: string,
    input: { readonly messageId: string; readonly text: string }
  ) => Effect.Effect<void>
  readonly waitForPendingMessages: (runId: string, signal: AbortSignal) => Promise<void>
}

export interface RunTotals {
  readonly prompt: number
  readonly completion: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number | undefined
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

export const pausedRunFailure = (
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

export const toRunModelMessages = (
  input: Pick<ChatWriteResume, "sessionId" | "activeMessages" | "automationContextMode" | "turnId">
): Effect.Effect<ReadonlyArray<ChatRunnerMessage>, StoredMessageDecodeError> => {
  if (input.automationContextMode !== AUTOMATION_CONTEXT_MODE.fresh) {
    return toChatRunnerMessages(input.sessionId, input.activeMessages)
  }
  const currentTurn = input.activeMessages.filter((message) => message.turn_id === input.turnId)
  if (currentTurn.length === 0) {
    return Effect.die(new Error("Fresh Automation run has no durable current-turn messages"))
  }
  return toChatRunnerMessages(input.sessionId, currentTurn)
}

export const isAgentEvent = (output: AgentEvent | LoopResult): output is AgentEvent =>
  "_tag" in output

export const runnerError = (input: Pick<ChatRun, "sessionId">, message: string): ChatMessageError =>
  new ChatMessageError({
    reason: "runner",
    message,
    sessionId: input.sessionId
  })

export const historyError = (
  input: Pick<ChatRun, "sessionId">,
  error: ResultHistoryError
): ChatMessageError =>
  new ChatMessageError({
    reason: "runner",
    message: error.message,
    sessionId: input.sessionId,
    ...(error.cause === undefined ? {} : { cause: error.cause })
  })

export const appendEventBatches = Effect.fn("ChatMessage.appendEventBatches")(function* (
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

export const accumulateRunTotals = (
  previous: RunTotals | undefined,
  result: LoopResult
): RunTotals => ({
  prompt: (previous?.prompt ?? 0) + result.usage.prompt_tokens,
  completion: (previous?.completion ?? 0) + result.usage.completion_tokens,
  cacheRead: (previous?.cacheRead ?? 0) + result.usage.cache_read_tokens,
  cacheWrite: (previous?.cacheWrite ?? 0) + result.usage.cache_write_tokens,
  cost: previous === undefined ? result.usage.cost : addCost(previous.cost, result.usage.cost),
  durationMs: (previous?.durationMs ?? 0) + result.duration_ms,
  toolTimeMs: (previous?.toolTimeMs ?? 0) + result.tool_time_ms,
  steps: (previous?.steps ?? 0) + result.steps
})

export const runTotalsUsage = (totals: RunTotals): StoredRunUsage => ({
  prompt: totals.prompt,
  completion: totals.completion,
  total: totals.prompt + totals.completion + totals.cacheRead + totals.cacheWrite,
  cache_read: totals.cacheRead,
  cache_write: totals.cacheWrite,
  ...(totals.cost === undefined ? {} : { cost: totals.cost })
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
  return code === CHAT_RUN_ERROR_CODE.contextLengthExceeded
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

export const finishWithFailure = Effect.fn("ChatMessage.finishWithFailure")(function* (
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
