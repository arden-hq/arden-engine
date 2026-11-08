import { ToolExecutionError } from "@arden-hq/loop"
import type {
  WorkflowEffectDisposition,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowSourceRef
} from "@arden-hq/protocol/workflows"
import { Effect, type Schema } from "effect"

import { errorMessage } from "@arden-hq/std/errors"
import { RecordedToolPause } from "../execution/recorded-tool-pause.js"
import type {
  ScriptDefinition,
  ScriptJournal,
  ScriptOrigin
} from "../persistence/scripts/journal.js"
import type { ScriptSettlement } from "../persistence/scripts/store.js"
import { scriptAgentKey } from "../persistence/workflows/script-identity.js"
import { addSourceRefs } from "../persistence/workflows/source-refs.js"
import type {
  ScriptAgentChildAttemptEvent,
  ScriptAgentObserver,
  ScriptAgentRequest,
  ScriptHost
} from "./runtime/contract.js"
import {
  executeScript,
  type ScriptOptions,
  type ScriptOutcome,
  type ScriptProgress
} from "./runtime/script-runtime.js"

export interface AdoptedScript {
  readonly adopt: (input: {
    readonly agent: (
      request: ScriptAgentRequest,
      observer: ScriptAgentObserver
    ) => Promise<Schema.Json>
    readonly signal: AbortSignal
    readonly onProgress: (progress: ScriptProgress) => void
  }) => Promise<ScriptOutcome>
}

export interface ScriptAttemptOptions {
  readonly origin: ScriptOrigin
  readonly attempt: number
  readonly definition: ScriptDefinition | undefined
  readonly profileHash: string
  readonly host: ScriptHost
  readonly journal: ScriptJournal["Service"]
  readonly signal: AbortSignal
  readonly adopted: AdoptedScript | undefined
  readonly onProgress: (progress: ScriptProgress) => void
  readonly onOutcome: (outcome: ScriptOutcome) => void
}

type ChildFailureEvent = Extract<ScriptAgentChildAttemptEvent, { readonly error: string }>

const isChildFailureEvent = (event: ScriptAgentChildAttemptEvent): event is ChildFailureEvent =>
  "error" in event

const isUnsafe = (effect: WorkflowEffectDisposition): effect is "applied" | "unknown" =>
  effect === "applied" || effect === "unknown"

const recoveryAction = (retryable: boolean): string | null => (retryable ? "retry" : null)

const childErrorCode = (status: ChildFailureEvent["status"]): WorkflowErrorCode => {
  switch (status) {
    case "invalid_output":
      return "schema_invalid"
    case "interrupted":
    case "cancelled":
      return status
    case "failed":
    case "launch_failed":
      return "agent_failed"
  }
}

const eventError = (event: ChildFailureEvent): WorkflowError => ({
  code: childErrorCode(event.status),
  message: event.error,
  retryable: event.retryable,
  recovery_action: recoveryAction(event.retryable)
})

const refusedStepError = (
  step: "agent" | "call",
  effect: "applied" | "unknown"
): WorkflowError => ({
  code: "uncertain_effect",
  message:
    effect === "applied"
      ? `An earlier run of this ${step} changed something outside Arden, so it does not run again`
      : `An earlier run of this ${step} may have changed something outside Arden, so it does not run again`,
  retryable: false,
  recovery_action: "review what it changed before running it again"
})

const agentFailure = (
  cause: unknown,
  signal: AbortSignal,
  effect: WorkflowEffectDisposition,
  lastEvent: ScriptAgentChildAttemptEvent | undefined
): { readonly uncertain: boolean; readonly error: WorkflowError } => {
  if (isUnsafe(effect)) {
    return {
      uncertain: true,
      error: {
        code: "uncertain_effect",
        message: errorMessage(cause, "A script agent stopped after it may have changed something"),
        retryable: false,
        recovery_action: "review what the agent changed before retrying"
      }
    }
  }
  if (signal.aborted) {
    return {
      uncertain: false,
      error: {
        code: "cancelled",
        message: "The script agent was cancelled",
        retryable: false,
        recovery_action: null
      }
    }
  }
  if (lastEvent !== undefined && isChildFailureEvent(lastEvent)) {
    return { uncertain: false, error: eventError(lastEvent) }
  }
  const retryable = cause instanceof ToolExecutionError && cause.retryable === true
  return {
    uncertain: false,
    error: {
      code: "agent_failed",
      message: errorMessage(cause, "A script agent failed"),
      retryable,
      recovery_action: recoveryAction(retryable)
    }
  }
}

const outcomeError = (outcome: Extract<ScriptOutcome, { readonly status: "failed" }>) =>
  ({
    code: outcome.error.code,
    message: outcome.error.message,
    retryable: outcome.error.retryable,
    recovery_action: recoveryAction(outcome.error.retryable),
    ...(outcome.error.preview === undefined ? {} : { preview: outcome.error.preview })
  }) satisfies WorkflowError

const attentionPreview = (tally: {
  readonly started: number
  readonly finished: number
}): string => {
  const stopped = Math.max(1, tally.started - tally.finished)
  const total = Math.max(tally.started, stopped)
  const who = stopped === 1 ? "one" : String(stopped)
  const what = stopped === 1 ? "it" : "they"
  return `${tally.finished} of ${total} agents finished; ${who} stopped before Arden could confirm what ${what} changed`
}

const sortedProgress = (progress: ScriptProgress): ScriptProgress => ({
  ...progress,
  agents: [...progress.agents].sort((left, right) => left.index - right.index)
})

class AgentNeedsReviewError extends Error {}

const failed = (code: WorkflowErrorCode, message: string): ScriptSettlement => ({
  status: "failed",
  value: null,
  error: { code, message, retryable: false, recovery_action: null },
  sourceRefs: []
})

export const executeScriptAttempt = async (
  options: ScriptAttemptOptions
): Promise<ScriptSettlement> => {
  if (options.adopted === undefined) {
    if (options.definition === undefined) {
      return failed("internal", "The script's code is no longer stored, so it cannot run again")
    }
    if (options.host.executionProfile.hash !== options.profileHash) {
      return failed("conflict", "Arden's agent setup changed since this script began")
    }
  }
  const { journal, origin } = options
  const local = new AbortController()
  const stop = (): void => local.abort(options.signal.reason)
  if (options.signal.aborted) stop()
  else options.signal.addEventListener("abort", stop, { once: true })

  const sources = new Map<string, WorkflowSourceRef>()
  const tally = { started: 0, finished: 0 }
  const inflight = new Set<Promise<unknown>>()
  const singleflight = new Map<
    string,
    { readonly specificationHash: string; readonly promise: Promise<Schema.Json> }
  >()
  let needsAttention: WorkflowError | undefined
  let lastAgentError: WorkflowError | undefined

  const runAgent = async (
    request: ScriptAgentRequest,
    runtimeObserver: ScriptAgentObserver
  ): Promise<Schema.Json> => {
    const decision = await Effect.runPromise(
      journal.agentDecision({
        ...origin,
        key: scriptAgentKey(request.logicalKey, request.specificationHash),
        schema: request.schema
      })
    ).catch((cause: unknown) => {
      throw new ToolExecutionError(errorMessage(cause, "The script's journal could not be read"), {
        preview: "Agent unavailable",
        retryable: true
      })
    })
    tally.started += 1
    if (decision.kind === "reuse") {
      runtimeObserver.recordReuse(decision.toolCallId)
      tally.finished += 1
      addSourceRefs(sources, decision.sourceRefs)
      return decision.value
    }
    if (decision.kind === "refuse") {
      const error = refusedStepError("agent", decision.effect)
      needsAttention ??= error
      lastAgentError = error
      throw new ToolExecutionError(error.message, { preview: "Needs review", retryable: false })
    }
    let effect: WorkflowEffectDisposition = "none"
    let lastEvent: ScriptAgentChildAttemptEvent | undefined
    const observer: ScriptAgentObserver = {
      reserveLaunch: runtimeObserver.reserveLaunch,
      recordReuse: runtimeObserver.recordReuse,
      recordChildAttempt: async (event) => {
        lastEvent = event
        await runtimeObserver.recordChildAttempt(event)
        if (event.status === "queued" || event.status === "running" || !("child" in event)) return
        const observed = await Effect.runPromise(journal.observeChild(event.child.runId))
        if (isUnsafe(observed.effectDisposition)) effect = observed.effectDisposition
        addSourceRefs(sources, observed.sourceRefs)
        if (isChildFailureEvent(event) && isUnsafe(effect)) {
          throw new AgentNeedsReviewError(event.error)
        }
      }
    }
    try {
      const value = await options.host.agent({ ...request, launch: decision.launch }, observer)
      tally.finished += 1
      return value
    } catch (cause) {
      const failure = agentFailure(cause, request.signal, effect, lastEvent)
      lastAgentError = failure.error
      if (failure.uncertain) needsAttention ??= failure.error
      throw cause
    }
  }

  const agent = (
    request: ScriptAgentRequest,
    observer: ScriptAgentObserver
  ): Promise<Schema.Json> => {
    const active = singleflight.get(request.logicalKey)
    if (active !== undefined && active.specificationHash === request.specificationHash) {
      return active.promise
    }
    const promise = runAgent(request, observer)
    inflight.add(promise)
    const settled = (): void => {
      inflight.delete(promise)
    }
    promise.then(settled, settled)
    if (active === undefined) {
      singleflight.set(request.logicalKey, {
        specificationHash: request.specificationHash,
        promise
      })
    }
    return promise
  }

  const tool: ScriptOptions["tool"] = async (request) => {
    const resolved = await Effect.runPromise(
      journal.nestedCall({ ...origin, toolCallId: request.toolCallId, attempt: options.attempt })
    )
    if (resolved.kind === "refuse") {
      const error = refusedStepError("call", resolved.effect)
      needsAttention ??= error
      throw new ToolExecutionError(error.message, { preview: "Needs review", retryable: false })
    }
    request.onResolved(resolved.toolCallId)
    return options.host.tool({
      ...request,
      toolCallId: resolved.toolCallId,
      detached: true,
      messages: []
    })
  }

  const onProgress = (progress: ScriptProgress): void =>
    options.onProgress(sortedProgress(progress))
  let outcome: ScriptOutcome
  try {
    outcome =
      options.adopted === undefined
        ? await executeScript({
            code: options.definition?.code ?? "",
            args: options.definition?.args ?? {},
            parentToolCallId: origin.originToolCallId,
            signal: local.signal,
            maxAgents: options.definition?.maxAgents ?? 0,
            executionProfileHash: options.profileHash,
            agent,
            tool,
            changesState: options.host.changesState,
            ...(options.host.describe === undefined ? {} : { describe: options.host.describe }),
            concurrencyGroup: options.host.concurrencyGroup,
            onProgress
          })
        : await options.adopted.adopt({ agent, signal: local.signal, onProgress })
  } catch (cause) {
    if (cause instanceof RecordedToolPause) throw cause
    const cancelled = options.signal.aborted
    outcome = {
      status: "failed",
      error: {
        code: cancelled ? "cancelled" : "internal",
        message: errorMessage(cause, "The script stopped unexpectedly"),
        retryable: !cancelled
      },
      calls: [],
      logs: [],
      phases: [],
      agents: []
    }
  } finally {
    options.signal.removeEventListener("abort", stop)
    local.abort()
  }
  options.onOutcome(outcome)
  await Promise.allSettled([...inflight])

  const sourceRefs = [...sources.values()]
  const value = outcome.status === "completed" ? outcome.value : null
  if (needsAttention !== undefined) {
    return {
      status: "needs_attention",
      value,
      error: { ...needsAttention, preview: attentionPreview(tally) },
      sourceRefs
    }
  }
  if (outcome.status === "completed") {
    return { status: "succeeded", value, error: null, sourceRefs }
  }
  const error =
    outcome.error.code === "agent_failed" && lastAgentError !== undefined
      ? lastAgentError
      : outcomeError(outcome)
  return {
    status: error.code === "cancelled" ? "cancelled" : "failed",
    value: null,
    error,
    sourceRefs
  }
}
