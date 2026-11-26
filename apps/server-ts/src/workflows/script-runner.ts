import { sleep } from "@arden-hq/std/sleep"
import { RecordedToolPause } from "../execution/recorded-tool-pause.js"
import type { JsonObject } from "@arden-hq/loop"
import { WORKFLOW_EFFECT, WORKFLOW_STATUS, type WorkflowStatus } from "@arden-hq/protocol/workflows"

import { Cause, Context, Effect, FiberSet, Layer, type Scope } from "effect"

import type { ServerToolRun } from "../chat/runner-contract.js"
import { ManagedOutputs } from "../artifacts/managed-output/managed-output.js"
import { RETRY_VERDICT, ScriptJournal, type RetryVerdict } from "../persistence/scripts/journal.js"
import { ScriptResults } from "../persistence/scripts/results.js"
import {
  ScriptStore,
  ScriptStoreError,
  type ScriptRecord,
  type ScriptSettlement
} from "../persistence/scripts/store.js"
import { drainScriptResults } from "./delivery.js"
import { ScriptShutdown, type ScriptHost } from "./runtime/contract.js"
import type { ScriptOutcome, ScriptProgress } from "./runtime/script-outcome.js"
import { executeScriptAttempt, type AdoptedScript } from "./script-attempt.js"
import { ATTEMPT_STEP, RETRY_CAUSE, attemptStep, interruptedByRestart } from "./script-retry.js"
import { SCRIPT_OUTCOME_STATUS } from "./runtime/script-outcome.js"
import { SCRIPT_PROGRESS_STATUS } from "./runtime/nested-trace.js"

interface ScriptBinding {
  readonly run: ServerToolRun
  readonly host: ScriptHost
}

export interface ScriptProgressSnapshot extends ScriptProgress {
  readonly logs: ReadonlyArray<string>
}

const emptyProgress: ScriptProgressSnapshot = { phases: [], agents: [], tools: [], logs: [] }

export const detachedScriptData = (input: {
  readonly workflowRef: string
  readonly version: number
  readonly attempt: number
  readonly status: WorkflowStatus
  readonly progress: ScriptProgressSnapshot
}): JsonObject => ({
  kind: "code_mode",
  phase_entries: [...(input.progress.phase_entries ?? [])],
  phases: [...input.progress.phases],
  agents: input.progress.agents.map((agent) => ({ ...agent })),
  tools: input.progress.tools.map((tool) => ({ ...tool })),
  logs: [...input.progress.logs],
  detached: {
    workflow_ref: input.workflowRef,
    version: input.version,
    attempt: input.attempt,
    status: input.status
  }
})

export const statusLine = (status: WorkflowStatus): string => {
  switch (status) {
    case WORKFLOW_STATUS.succeeded:
      return "Script finished"
    case WORKFLOW_STATUS.failed:
      return "Script failed"
    case WORKFLOW_STATUS.cancelled:
      return "Script cancelled"
    case WORKFLOW_STATUS.needs_attention:
      return "Script stopped for review"
    case WORKFLOW_STATUS.queued:
    case WORKFLOW_STATUS.running:
    case WORKFLOW_STATUS.needs_input:
    case WORKFLOW_STATUS.cancelling:
      return "Script running"
  }
}

const DRIVE_START = { run: "run", after: "after" } as const

type DriveStart =
  | {
      readonly kind: typeof DRIVE_START.run
      readonly adopted: AdoptedScript | undefined
      readonly progress: ScriptProgressSnapshot
    }
  | { readonly kind: typeof DRIVE_START.after; readonly settlement: ScriptSettlement }

interface LiveScript {
  readonly controller: AbortController
  readonly binding: ScriptBinding
}

interface ScriptRunnerShape {
  readonly owns: (ref: string) => boolean
  readonly start: (input: {
    readonly record: ScriptRecord
    readonly binding: ScriptBinding
    readonly adopted: AdoptedScript
    readonly progress: ScriptProgressSnapshot
  }) => Effect.Effect<void>
  readonly resume: (input: {
    readonly record: ScriptRecord
    readonly binding: ScriptBinding
  }) => Effect.Effect<void, ScriptStoreError>
  readonly retry: (input: {
    readonly ref: string
    readonly expectedVersion: number
    readonly binding: ScriptBinding
  }) => Effect.Effect<ScriptRecord, ScriptStoreError>
  readonly cancel: (input: {
    readonly ref: string
    readonly cancelAgent: (input: { readonly runId: string }) => Promise<void>
  }) => Effect.Effect<ScriptRecord, ScriptStoreError>
  readonly cancelFenced: (input: {
    readonly cancelAgent: (input: { readonly runId: string }) => Promise<void>
  }) => Effect.Effect<void, ScriptStoreError>
}

const journalFailure = (ref: string) => (cause: unknown) =>
  new ScriptStoreError({
    reason: "storage",
    message: "The script's journal could not be read",
    ref,
    cause
  })

const makeScriptRunner = Effect.fn("ScriptRunner.make")(function* (): Effect.fn.Return<
  ScriptRunnerShape,
  never,
  ScriptStore | ScriptJournal | ScriptResults | ManagedOutputs | Scope.Scope
> {
  const store = yield* ScriptStore
  const journal = yield* ScriptJournal
  const results = yield* ScriptResults
  const outputs = yield* ManagedOutputs
  const fibers = yield* FiberSet.make<void, never>()
  const live = new Map<string, LiveScript>()

  const origin = (record: ScriptRecord) => ({
    originRunId: record.originRunId,
    originToolCallId: record.originToolCallId
  })

  const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
    sleep(ms, signal).catch(() => undefined)

  const drive = async (
    initial: ScriptRecord,
    binding: ScriptBinding,
    start: DriveStart,
    shutdown: AbortSignal,
    self: LiveScript
  ): Promise<void> => {
    const controller = self.controller
    const stopForShutdown = (): void => controller.abort(new ScriptShutdown())
    if (shutdown.aborted) stopForShutdown()
    else shutdown.addEventListener("abort", stopForShutdown, { once: true })
    let record = initial
    let next = start
    let progress = start.kind === DRIVE_START.run ? start.progress : emptyProgress
    let pendingProgress = Promise.resolve()
    const emit = (status: WorkflowStatus, message: string): Promise<void> => {
      const data = detachedScriptData({
        workflowRef: record.ref,
        version: record.version,
        attempt: record.attempt,
        status,
        progress
      })
      const identity = { ref: record.ref, attempt: record.attempt }
      pendingProgress = pendingProgress.then(async () => {
        await Effect.runPromise(store.progress({ ...identity, data }))
        await binding.run
          .emitToolProgress({ toolCallId: record.originToolCallId, message, data })
          .catch(() => undefined)
      })
      void pendingProgress.catch(() => undefined)
      return pendingProgress
    }
    const stopped = async (): Promise<void> => {
      if (controller.signal.reason instanceof ScriptShutdown) return
      const cancelled = await Effect.runPromise(store.get(record.ref)).catch(() => undefined)
      if (cancelled === undefined) return
      record = cancelled
      await emit(cancelled.status, statusLine(cancelled.status))
    }
    try {
      while (!controller.signal.aborted) {
        const settlement =
          next.kind === DRIVE_START.after
            ? next.settlement
            : await runAttempt(record, binding, next.adopted, controller.signal, {
                onProgress: (current) => {
                  progress = { ...current, logs: progress.logs }
                  const done = current.agents.filter(
                    (agent) => agent.status === SCRIPT_PROGRESS_STATUS.completed
                  )
                  void emit(
                    "running",
                    current.agents.length > 0
                      ? `${done.length}/${current.agents.length} agents done`
                      : (current.phases.at(-1) ?? "Running")
                  )
                },
                onOutcome: (outcome: ScriptOutcome) => {
                  progress = {
                    phase_entries: progress.phase_entries ?? [],
                    phases: outcome.phases.length ? [...outcome.phases] : progress.phases,
                    agents:
                      outcome.status === SCRIPT_OUTCOME_STATUS.failed && outcome.agents.length
                        ? [...outcome.agents]
                        : progress.agents,
                    tools: progress.tools,
                    logs: [...outcome.logs]
                  }
                },
                onStart: () => void emit("running", "Script started")
              })
        if (controller.signal.aborted) return await stopped()
        await emit("running", "Attempt finished")
        const step = await nextStep(
          record,
          settlement,
          next.kind === DRIVE_START.after ? RETRY_CAUSE.restart : RETRY_CAUSE.attempt
        )
        if (step.kind === ATTEMPT_STEP.retry) {
          await sleepUnlessAborted(step.delayMs, controller.signal)
          if (controller.signal.aborted) return await stopped()
          record = await Effect.runPromise(
            store.nextAttempt({ ref: record.ref, attempt: record.attempt, auto: step.counted })
          )
          progress = emptyProgress
          next = { kind: "run", adopted: undefined, progress }
          continue
        }
        const settled = await Effect.runPromise(
          store.settle({ ref: record.ref, attempt: record.attempt, settlement: step.settlement })
        )
        if (settled === undefined) return
        record = settled
        await emit(settled.status, statusLine(settled.status))
        await Effect.runPromise(
          drainScriptResults({ results, limit: 25, send: binding.run.sendMessage, outputs }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("A script result is waiting for its next send", cause)
            )
          )
        )
        return
      }
    } catch (cause) {
      if (!(cause instanceof RecordedToolPause)) throw cause
      await emit("needs_input", "Waiting for approval")
    } finally {
      shutdown.removeEventListener("abort", stopForShutdown)
    }
  }

  const runAttempt = async (
    record: ScriptRecord,
    binding: ScriptBinding,
    adopted: AdoptedScript | undefined,
    signal: AbortSignal,
    hooks: {
      readonly onProgress: (progress: ScriptProgress) => void
      readonly onOutcome: (outcome: ScriptOutcome) => void
      readonly onStart: () => void
    }
  ): Promise<ScriptSettlement> => {
    hooks.onStart()
    const definition =
      adopted === undefined
        ? await Effect.runPromise(journal.definition(origin(record))).catch(() => undefined)
        : undefined
    return executeScriptAttempt({
      origin: origin(record),
      attempt: record.attempt,
      definition,
      profileHash: record.profileHash,
      host: binding.host,
      journal,
      signal,
      adopted,
      onProgress: hooks.onProgress,
      onOutcome: hooks.onOutcome
    })
  }

  const nextStep = async (
    record: ScriptRecord,
    settlement: ScriptSettlement,
    cause: (typeof RETRY_CAUSE)[keyof typeof RETRY_CAUSE]
  ) => {
    const step = attemptStep({
      cause,
      settlement,
      autoRetries: record.autoRetries,
      verdict: undefined
    })
    if (step.kind !== ATTEMPT_STEP.check) return step
    const verdict = await Effect.runPromise(journal.retryVerdict(origin(record))).catch(
      (): RetryVerdict => ({ kind: RETRY_VERDICT.refuse, effect: WORKFLOW_EFFECT.unknown })
    )
    const checked = attemptStep({ cause, settlement, autoRetries: record.autoRetries, verdict })
    return checked.kind === ATTEMPT_STEP.check ? { kind: ATTEMPT_STEP.settle, settlement } : checked
  }

  const fork = (record: ScriptRecord, binding: ScriptBinding, start: DriveStart) =>
    Effect.suspend(() => {
      if (live.has(record.ref)) return Effect.void
      const self: LiveScript = { controller: new AbortController(), binding }
      live.set(record.ref, self)
      return FiberSet.run(
        fibers,
        Effect.promise((shutdown) => drive(record, binding, start, shutdown, self)).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("A detached script stopped without settling", {
                  ref: record.ref,
                  cause
                })
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (live.get(record.ref) === self) live.delete(record.ref)
            })
          )
        )
      ).pipe(Effect.asVoid)
    })

  const start: ScriptRunnerShape["start"] = (input) =>
    live.has(input.record.ref) || input.record.status !== WORKFLOW_STATUS.running
      ? Effect.void
      : fork(input.record, input.binding, {
          kind: DRIVE_START.run,
          adopted: input.adopted,
          progress: input.progress
        })

  const resume: ScriptRunnerShape["resume"] = Effect.fn("ScriptRunner.resume")(function* (input) {
    if (live.has(input.record.ref)) return
    const record = yield* store.get(input.record.ref)
    if (record.status !== WORKFLOW_STATUS.running) return
    if (
      yield* journal
        .awaitingDecision(origin(record))
        .pipe(Effect.mapError(journalFailure(record.ref)))
    )
      return
    const children = yield* journal
      .activeChildRuns(origin(record))
      .pipe(Effect.mapError(journalFailure(record.ref)))
    if (children.length > 0) return
    yield* fork(record, input.binding, {
      kind: DRIVE_START.after,
      settlement: interruptedByRestart
    })
  })

  const retry: ScriptRunnerShape["retry"] = Effect.fn("ScriptRunner.retry")(function* (input) {
    const current = yield* store.get(input.ref)
    const verdict = yield* journal
      .retryVerdict(origin(current))
      .pipe(Effect.mapError(journalFailure(input.ref)))
    if (verdict.kind === RETRY_VERDICT.refuse) {
      return yield* new ScriptStoreError({
        reason: "unsafe_retry",
        message:
          verdict.effect === WORKFLOW_EFFECT.applied
            ? "The script is not run again: an earlier step changed something outside Arden"
            : "The script is not run again: an earlier step may have changed something outside Arden",
        ref: input.ref
      })
    }
    const record = yield* store.retry({ ref: input.ref, expectedVersion: input.expectedVersion })
    yield* fork(record, input.binding, {
      kind: DRIVE_START.run,
      adopted: undefined,
      progress: emptyProgress
    })
    return record
  })

  const cancel: ScriptRunnerShape["cancel"] = Effect.fn("ScriptRunner.cancel")(function* (input) {
    const record = yield* store.cancel(input.ref)
    if (record.status !== WORKFLOW_STATUS.cancelled) return record
    const running = live.get(input.ref)
    running?.controller.abort(new DOMException("Script cancelled", "AbortError"))
    const runIds = yield* journal
      .activeChildRuns(origin(record))
      .pipe(Effect.catchCause(() => Effect.succeed([])))
    const cancelAgent = running?.binding.run.cancelAgent ?? input.cancelAgent
    yield* Effect.promise(() => Promise.allSettled(runIds.map((runId) => cancelAgent({ runId }))))
    return record
  })

  const cancelFenced: ScriptRunnerShape["cancelFenced"] = Effect.fn("ScriptRunner.cancelFenced")(
    function* (input) {
      for (const record of yield* store.runningOfFencedRuns())
        yield* cancel({ ref: record.ref, cancelAgent: input.cancelAgent })
    }
  )

  return { start, resume, retry, cancel, cancelFenced, owns: (ref) => live.has(ref) }
})

export class ScriptRunner extends Context.Service<ScriptRunner, ScriptRunnerShape>()(
  "@arden-hq/server/workflows/ScriptRunner"
) {
  static readonly layer: Layer.Layer<
    ScriptRunner,
    never,
    ScriptStore | ScriptJournal | ScriptResults | ManagedOutputs
  > = Layer.effect(ScriptRunner, makeScriptRunner())
}
