import type { ChatReceipt } from "@arden-hq/protocol/chat"
import { sanitizeApprovalPresentation } from "@arden-hq/protocol/chat"
import { failedToolResult, PauseRequested, ToolExecutionError } from "@arden-hq/loop"
import type { ToolResult } from "@arden-hq/loop"
import { Cause, Effect, Result, Semaphore } from "effect"
import { ChatEventStore } from "../persistence/events/store.js"
import { toolFailure, toolRefusal } from "../tools/tool-failure.js"
import type { CommittedEventBatch, EventDraft } from "../persistence/events/model.js"
import {
  ChatAgentSpawnError,
  ChatWriteConflictError,
  ChatWriteError,
  ChatWriteStore,
  type ChatWriteResume,
  type ChatWriteSpawnAgentInput
} from "../persistence/chat/store.js"
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

export interface ToolHost {
  readonly lifecycle: Semaphore.Semaphore
  readonly launch: (run: ChatWriteResume) => Effect.Effect<void>
  readonly cancelAgent: (input: {
    readonly runId: string
  }) => Effect.Effect<void, ChatMessageFailure>
  readonly sendMessage: (
    request: ChatRunnerSendMessageRequest
  ) => Effect.Effect<ChatReceipt, ChatMessageFailure>
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
    const presentation = sanitizeApprovalPresentation(pause.presentation)
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
        event: { type: "TOOL_CALL_WAITING", tool_call_id: request.toolCallId },
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
        backgrounded: new Set([...backgroundedMutations, ...host.heldBackground.held(run.runId)])
      })
    ).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        if (error instanceof ToolExecutionStoreError && error.reason === "blocked") {
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
                blocker === "stalled"
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
    if (begun._tag === "Recovered") {
      if (request.changesState && begun.outcome.status === "uncertain") {
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

    const settled = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          Promise.resolve(
            operation(begun.approval === undefined ? undefined : { approval: begun.approval })
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
          event: {
            type: "TOOL_CALL_PROGRESS",
            tool_call_id: request.toolCallId,
            message: request.message,
            ...(request.data === undefined ? {} : { data: request.data })
          },
          runId: run.runId,
          admission: "detached"
        })
      ),
    emitToolOutput: (request) =>
      runPromise(
        appendToolEvent({
          event: {
            type: "TOOL_CALL_OUTPUT_DELTA",
            tool_call_id: request.toolCallId,
            stream: request.stream,
            delta: request.delta
          },
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

const toolIdentity = (
  run: Pick<ToolRun, "runId" | "sessionId">,
  request: ChatRunnerToolRequest
): ToolExecutionIdentity => ({
  runId: run.runId,
  sessionId: run.sessionId,
  toolCallId: request.toolCallId,
  toolName: request.name,
  arguments: request.args,
  changesState: request.changesState,
  ...(request.effect === undefined ? {} : { effect: request.effect }),
  ...(request.source === undefined ? {} : { source: request.source })
})

const spawnInput = (
  run: Pick<ToolRun, "runId" | "sessionId">,
  request: ChatRunnerSpawnAgentRequest
): ChatWriteSpawnAgentInput => {
  const parent: ToolExecutionIdentity = {
    runId: run.runId,
    sessionId: run.sessionId,
    toolCallId: request.toolCallId,
    toolName: "spawn_agent",
    arguments: request.arguments,
    changesState: true,
    effect: "arden_db"
  }
  const base = {
    parent,
    task: request.task,
    ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    ...(request.taskItemId === undefined ? {} : { taskItemId: request.taskItemId }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.forkHistory === undefined ? {} : { forkHistory: request.forkHistory })
  }
  return request.mode === "code"
    ? {
        ...base,
        mode: "code",
        workspace: request.workspace,
        ...(request.requestedWorkingDirectory === undefined
          ? {}
          : { requestedWorkingDirectory: request.requestedWorkingDirectory })
      }
    : { ...base, mode: request.mode }
}

const spawnFailure = (cause: unknown): ToolExecutionError => {
  if (cause instanceof ChatAgentSpawnError) {
    return new ToolExecutionError(cause.message, {
      preview: spawnErrorPreview(cause.reason),
      retryable: cause.retryable
    })
  }
  if (cause instanceof ChatWriteError) return toolFailure(cause, "Agent was not started")
  if (cause instanceof ChatWriteConflictError)
    return toolRefusal(cause.message, "Agent was not started")
  return new ToolExecutionError("The agent Session could not be started", {
    preview: "Agent was not started",
    retryable: true
  })
}

const spawnErrorPreview = (reason: ChatAgentSpawnError["reason"]): string => {
  switch (reason) {
    case "max_depth":
      return "Agent depth limit reached"
    case "invalid_parent":
      return "Agent was not started"
    case "working_directory":
      return "Working directory required"
  }
}
