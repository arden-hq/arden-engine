import {
  MUTATION_BLOCKER,
  TOOL_EXECUTION_BEGIN,
  TOOL_STORE_FAILURE
} from "../persistence/tools/store.js"
import { RUN_AUTHORITY_STATE } from "../persistence/sqlite/run-context.js"
import { TOOL_STATUS } from "../persistence/sqlite/status-sets.js"
import { CALL_PLAN } from "../persistence/sqlite/task-direction.js"
import type { ChatSendReceipt } from "../persistence/chat/send-contracts.js"
import { cleanApprovalDraft } from "../persistence/tools/approval-draft.js"
import { failedToolResult, PauseRequested, ToolExecutionError } from "@arden-hq/loop"
import type { ToolResult } from "@arden-hq/loop"
import { Cause, Effect, Result, Semaphore } from "effect"
import { ChatEventStore } from "../persistence/events/store.js"
import { toolRefusal } from "../tools/tool-failure.js"
import type { CommittedEventBatch, EventDraft } from "../persistence/events/model.js"
import { ChatWriteStore, type ChatWriteResume } from "../persistence/chat/store.js"
import {
  TOOL_MUTATION_STALLED,
  TOOL_OUTCOME_UNCERTAIN,
  TOOL_PERSISTENCE_FAILED,
  ToolExecutionStore,
  ToolExecutionStoreError,
  type ToolExecutionIdentity
} from "../persistence/tools/store.js"
import type {
  ChatRunnerSendMessageRequest,
  ChatRunnerSpawnAgentRequest,
  ChatRunnerToolRequest,
  ChatRunnerTools,
  ServerToolRun
} from "./runner-contract.js"
import type { ChatMessageFailure } from "./message-errors.js"
import type { HeldBackground } from "./held-background.js"
import { RecordedToolPause } from "../execution/recorded-tool-pause.js"
import { taskDirectionReview } from "../persistence/work/task-direction.js"
import { toolOutputEvent, toolProgressEvent, toolWaitingEvent } from "./tool-events.js"
import { spawnFailure, spawnInput, toolIdentity } from "./tool-request-mapping.js"

export interface ToolHost {
  readonly lifecycle: Semaphore.Semaphore
  readonly launch: (run: ChatWriteResume) => Effect.Effect<void>
  readonly cancelAgent: (input: {
    readonly runId: string
  }) => Effect.Effect<void, ChatMessageFailure>
  readonly sendMessage: (
    request: ChatRunnerSendMessageRequest
  ) => Effect.Effect<ChatSendReceipt, ChatMessageFailure>
  readonly detachedRun: (input: {
    readonly sessionId: string
    readonly runId: string
  }) => Effect.Effect<ServerToolRun, ChatMessageFailure>
  readonly draining: () => boolean
  readonly heldBackground: HeldBackground
}

export interface ToolRun {
  readonly sessionId: string
  readonly runId: string
  readonly signal: AbortSignal
  readonly eventSequence: { value: number | undefined }
}

type ToolOperation = Parameters<ChatRunnerTools["execute"]>[1]

interface Halt {
  readonly reason: string
  readonly detail?: string | undefined
  readonly cause?: Cause.Cause<unknown>
  readonly recordedToolCallId?: string
}

const UNCERTAIN_MUTATION =
  "A state-changing tool outcome is uncertain and must be verified before another mutation"
const STALLED_MUTATION = "An earlier change in this run was approved but never ran"
const SETTLING = toolRefusal(
  "This run's Task is finished, so this did not run. Say your closing reply.",
  "Not run: the Task is finished"
)
const REVOKED = toolRefusal(
  "This run may no longer act for its work, so this did not run.",
  "Not run: the run was stopped"
)

const UNRECORDED_APPROVAL_RESULT = Object.freeze({
  content: "Tool approval could not be recorded, so the tool was not executed.",
  preview: "Tool approval was not recorded",
  is_error: true,
  retryable: false,
  data: Object.freeze({ outcome: "approval_not_recorded" })
} satisfies ToolResult)

export const makeDurableTools = Effect.fn("ChatMessage.durableTools")(function* (
  host: ToolHost,
  run: ToolRun
): Effect.fn.Return<ChatRunnerTools, never, ChatWriteStore | ChatEventStore | ToolExecutionStore> {
  const store = yield* ChatWriteStore
  const events = yield* ChatEventStore
  const toolStore = yield* ToolExecutionStore
  const context = yield* Effect.context<never>()
  const runPromise = Effect.runPromiseWith(context)
  let mutationHalt: Pick<Halt, "reason" | "detail" | "recordedToolCallId"> | undefined
  const mutationPermit = Semaphore.makeUnsafe(1)
  const backgroundedMutations = new Set<string>()

  const appendToolEvent = (event: EventDraft) =>
    events
      .append({ sessionId: run.sessionId, events: [event] })
      .pipe(Effect.map((committed) => advanceEventSequence(run, committed)))

  const halt = Effect.fn("ChatMessage.haltTool")(function* (
    request: ChatRunnerToolRequest,
    stop: Halt
  ): Effect.fn.Return<never, PauseRequested> {
    const cause = stop.cause === undefined ? undefined : Cause.squash(stop.cause)
    if (cause !== undefined) {
      yield* Effect.logWarning("Tool execution halted", {
        tool: request.name,
        reason: stop.reason,
        detail: stop.detail,
        cause: String(cause)
      })
    }
    const stopped = {
      reason: stop.reason,
      ...(stop.detail === undefined ? {} : { detail: stop.detail }),
      ...(stop.recordedToolCallId === undefined
        ? {}
        : { recordedToolCallId: stop.recordedToolCallId })
    }
    const halted = request.changesState ? (mutationHalt ??= stopped) : stopped
    const pause = new PauseRequested(halted.reason, halted.detail)
    return yield* Effect.fail(
      halted.recordedToolCallId === undefined
        ? pause
        : new RecordedToolPause(halted.recordedToolCallId, pause)
    )
  })

  const recordPause = (
    request: ChatRunnerToolRequest,
    identity: ToolExecutionIdentity,
    pause: PauseRequested
  ): Effect.Effect<ToolResult, PauseRequested> => {
    const presentation = cleanApprovalDraft(pause.presentation)
    const record: Effect.Effect<void, unknown> =
      pause.presentation !== undefined && presentation === undefined
        ? Effect.fail("Invalid tool approval presentation")
        : toolStore.pause(identity, {
            reason: pause.reason,
            ...(pause.detail === undefined ? {} : { detail: pause.detail }),
            ...(pause.preview === undefined ? {} : { preview: pause.preview }),
            ...(pause.diff === undefined ? {} : { diff: pause.diff }),
            ...(presentation === undefined ? {} : { presentation }),
            ...(pause.data === undefined ? {} : { data: pause.data })
          })
    return record.pipe(
      Effect.matchCauseEffect({
        onFailure: () =>
          toolStore.complete(identity, UNRECORDED_APPROVAL_RESULT).pipe(
            Effect.catchCause((cause) =>
              halt(request, {
                reason: TOOL_PERSISTENCE_FAILED,
                detail: "Tool execution paused before its durable state could be recorded",
                cause
              })
            )
          ),
        onSuccess: () =>
          halt(request, {
            reason: pause.reason,
            detail: pause.detail,
            recordedToolCallId: request.toolCallId
          })
      })
    )
  }

  const execute = Effect.fn("ChatMessage.executeTool")(function* (
    request: ChatRunnerToolRequest,
    operation: ToolOperation,
    options: { readonly detached: boolean }
  ): Effect.fn.Return<ToolResult, unknown> {
    const identity = toolIdentity(run, request)
    const fenced = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      options.detached ? effect : whileRunActive(host, run, effect)
    if (request.changesState && mutationHalt !== undefined) {
      const held = mutationHalt
      yield* appendToolEvent({
        event: toolWaitingEvent(request.toolCallId),
        runId: run.runId
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not mark a queued tool call as waiting", {
            tool: request.name,
            cause: String(Cause.squash(cause))
          })
        )
      )
      const pause = new PauseRequested(held.reason, held.detail)
      return yield* Effect.fail(
        held.recordedToolCallId === undefined
          ? pause
          : new RecordedToolPause(held.recordedToolCallId, pause)
      )
    }
    const begun = yield* fenced(
      toolStore.begin(identity, {
        backgrounded: new Set([...backgroundedMutations, ...host.heldBackground.held(run.runId)]),
        ...(request.plan === undefined ? {} : { plan: request.plan })
      })
    ).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        if (
          error instanceof ToolExecutionStoreError &&
          error.reason === TOOL_STORE_FAILURE.blocked
        ) {
          return toolStore
            .requireOutcomeDecision({ runId: run.runId, sessionId: run.sessionId })
            .pipe(
              Effect.catchCause((decisionCause) =>
                halt(request, {
                  reason: TOOL_PERSISTENCE_FAILED,
                  detail: "The uncertain tool outcome could not be saved for a decision",
                  cause: decisionCause
                })
              ),
              Effect.flatMap((blocker) =>
                blocker === MUTATION_BLOCKER.stalled
                  ? halt(request, { reason: TOOL_MUTATION_STALLED, detail: STALLED_MUTATION })
                  : halt(request, { reason: TOOL_OUTCOME_UNCERTAIN, detail: UNCERTAIN_MUTATION })
              )
            )
        }
        return halt(request, {
          reason: TOOL_PERSISTENCE_FAILED,
          detail: "Tool execution did not start because its durable state could not be recorded",
          cause
        })
      })
    )
    if (begun._tag === TOOL_EXECUTION_BEGIN.notAdmitted) {
      if (begun.authority === RUN_AUTHORITY_STATE.settling) return failedToolResult(SETTLING)
      if (!options.detached)
        yield* host.cancelAgent({ runId: run.runId }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : halt(request, {
                  reason: TOOL_PERSISTENCE_FAILED,
                  detail: "The run lost its authority, but its stop could not be recorded",
                  cause
                })
          )
        )
      return failedToolResult(REVOKED)
    }
    if (begun._tag === TOOL_EXECUTION_BEGIN.recovered) {
      if (request.changesState && begun.outcome.status === TOOL_STATUS.uncertain) {
        return yield* halt(request, { reason: TOOL_OUTCOME_UNCERTAIN, detail: UNCERTAIN_MUTATION })
      }
      return begun.outcome.result
    }

    const uncertain = toolStore.uncertain(identity).pipe(
      Effect.catchCause((cause) =>
        halt(request, {
          reason: TOOL_PERSISTENCE_FAILED,
          detail: "Tool execution stopped because its outcome could not be recorded",
          cause
        })
      ),
      Effect.flatMap((result) =>
        request.changesState
          ? halt(request, { reason: TOOL_OUTCOME_UNCERTAIN, detail: result.content })
          : Effect.succeed(result)
      )
    )
    const complete = (result: ToolResult) =>
      toolStore.complete(identity, result).pipe(Effect.catchCause(() => uncertain))

    const admit = (): Promise<ToolResult | undefined> =>
      request.changesState
        ? runPromise(
            toolStore.admitPlanned(identity).pipe(
              Effect.map((plan) =>
                plan === CALL_PLAN.current ? undefined : failedToolResult(taskDirectionReview())
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : halt(request, {
                      reason: TOOL_PERSISTENCE_FAILED,
                      detail: "The call's plan could not be checked against its Task",
                      cause
                    })
              )
            )
          )
        : Promise.resolve(undefined)
    const settled = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          Promise.resolve(
            operation({
              ...(begun.approval === undefined ? {} : { approval: begun.approval }),
              admit
            })
          ),
        catch: (cause) => cause
      })
    )
    if (Result.isSuccess(settled)) return yield* complete(settled.success)
    const cause = settled.failure
    if (cause instanceof RecordedToolPause) {
      yield* toolStore.suspend(identity, cause.toolCallId).pipe(
        Effect.catchCause((failure) =>
          halt(request, {
            reason: TOOL_PERSISTENCE_FAILED,
            detail: "The suspended coordinator could not be recorded",
            cause: failure
          })
        )
      )
      return yield* Effect.fail(cause)
    }
    if (cause instanceof PauseRequested) {
      return yield* cause.reason === TOOL_OUTCOME_UNCERTAIN
        ? uncertain
        : recordPause(request, identity, cause)
    }
    if (cause instanceof ToolExecutionError) {
      return yield* complete(failedToolResult(cause))
    }
    if (host.draining()) return yield* Effect.fail(cause)
    return yield* uncertain
  })

  const runTool = (
    request: ChatRunnerToolRequest,
    operation: ToolOperation,
    options: { readonly detached: boolean; readonly backgrounded?: Promise<void> }
  ): Promise<ToolResult> => {
    const executed = execute(request, operation, options)
    return runPromise(
      request.changesState
        ? serialized(request.toolCallId, executed, options.backgrounded)
        : executed
    )
  }

  const serialized = <A, E>(
    toolCallId: string,
    effect: Effect.Effect<A, E>,
    backgrounded: Promise<void> | undefined
  ): Effect.Effect<A, E> =>
    Effect.uninterruptibleMask((restore) =>
      restore(mutationPermit.take(1)).pipe(
        Effect.andThen(() => {
          let held = true
          const release = (): void => {
            if (!held) return
            held = false
            Effect.runSync(mutationPermit.release(1))
          }
          void backgrounded?.then(() => {
            if (!held) return
            backgroundedMutations.add(toolCallId)
            release()
          })
          return restore(effect).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                backgroundedMutations.delete(toolCallId)
                release()
              })
            )
          )
        })
      )
    )

  const spawnAgent = Effect.fn("ChatMessage.spawnAgent")(
    function* (request: ChatRunnerSpawnAgentRequest) {
      const commit = yield* store.prepareSpawnAgent(spawnInput(run, request))
      return yield* Effect.uninterruptible(
        host.lifecycle.withPermit(
          Effect.gen(function* () {
            const spawned = yield* commit
            yield* host.launch(spawned.child).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Could not launch spawned agent Session", {
                  childSessionId: spawned.child.sessionId,
                  childRunId: spawned.child.runId,
                  cause
                })
              )
            )
            return {
              content: spawned.result.content,
              preview: spawned.result.preview,
              ...(spawned.result.data === undefined ? {} : { data: spawned.result.data }),
              ...(spawned.result.host === undefined ? {} : { host: spawned.result.host })
            } satisfies ToolResult
          })
        )
      )
    },
    Effect.catchCause((cause) => Effect.fail(spawnFailure(Cause.squash(cause))))
  )

  return {
    execute: (request, operation, options) =>
      runTool(request, operation, {
        detached: false,
        ...(options?.backgrounded === undefined ? {} : { backgrounded: options.backgrounded })
      }),
    executeDetached: (request, operation) => runTool(request, operation, { detached: true }),
    recover: (calls) =>
      runPromise(
        whileRunActive(
          host,
          run,
          toolStore.recover(calls.map((call) => toolIdentity(run, call)))
        ).pipe(
          Effect.map(
            (recovered) =>
              new Map([...recovered].map(([toolCallId, outcome]) => [toolCallId, outcome.result]))
          )
        )
      ),
    holdBackground: (calls) => host.heldBackground.hold(run.runId, calls),
    claimBackground: (toolCallIds) => host.heldBackground.claim(run.runId, toolCallIds),
    spawnAgent: (request) => runPromise(spawnAgent(request)),
    cancelAgent: (request) => runPromise(host.cancelAgent(request)),
    sendMessage: (request) => runPromise(host.sendMessage(request)),
    detachedRun: (input) => runPromise(host.detachedRun(input)),
    emitToolProgress: (request) =>
      runPromise(
        appendToolEvent({
          event: toolProgressEvent(request),
          runId: run.runId,
          admission: "detached"
        })
      ),
    emitToolOutput: (request) =>
      runPromise(
        appendToolEvent({
          event: toolOutputEvent(request),
          runId: run.runId
        })
      ),
    declareEffectTarget: (request) =>
      runPromise(
        toolStore.target({
          runId: run.runId,
          toolCallId: request.toolCallId,
          target: request.target,
          origin: request.origin
        })
      )
  } satisfies ChatRunnerTools
})

export const whileRunActive = <A, E, R>(
  host: Pick<ToolHost, "lifecycle">,
  run: Pick<ToolRun, "signal">,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  host.lifecycle.withPermit(Effect.suspend(() => (run.signal.aborted ? Effect.interrupt : effect)))

export const advanceEventSequence = (
  run: Pick<ToolRun, "eventSequence">,
  committed: CommittedEventBatch
): void => {
  run.eventSequence.value = Math.max(run.eventSequence.value ?? 0, committed.headSequence)
}
