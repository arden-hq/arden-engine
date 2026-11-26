import { ROLE } from "@arden-hq/std/message-vocabulary"
import { abortError, isAbortError, raceAbort } from "../abort.js"
import {
  makeFairReadWriteLock,
  makeSemaphore,
  type FairReadWriteLock,
  type Semaphore
} from "../internal/concurrency.js"
import { failedToolResult, PauseRequested, ToolExecutionError, toToolFailure } from "../errors.js"
import { applyToolCallMiddleware } from "../agent/middleware.js"
import {
  messageId,
  type ChatMessage,
  type ContentBlock,
  type ToolCall
} from "../contracts/messages.js"
import {
  canRunInBackground,
  type PendingToolCall,
  type ToolArgumentErrorCode,
  type ToolCallMiddleware,
  type ToolCallRequest,
  type ToolMeta,
  TOOL_PHASE,
  type ToolPhase,
  type ToolProgressUpdate,
  type ToolResult,
  type Toolset
} from "../contracts/tools.js"
import {
  isToolPaused,
  type AgentEvent,
  type ToolCompleted,
  type ToolPaused
} from "../contracts/events.js"
import { EventQueue } from "../internal/stream.js"
import { completed, makeResolved, paused, started, type ResolvedCall } from "./tool-events.js"
import { normalizeToolResult } from "../internal/validate.js"
import { after, type Timer } from "@arden-hq/std/timer"

export interface DispatchInput {
  readonly messages: ChatMessage[]
  readonly calls: ReadonlyArray<PendingToolCall>
  readonly rawCalls: ReadonlyArray<ToolCall>
  readonly metas: ReadonlyMap<string, ToolMeta>
  readonly toolset: Toolset
  readonly beforeExecute?: () => Promise<ToolResult | undefined>
  readonly middleware: ReadonlyArray<ToolCallMiddleware>
  readonly groups?: Map<string, FairReadWriteLock>
  readonly stateChanges?: Semaphore
  readonly semaphore: Semaphore
  readonly clock: () => number
  readonly signal: AbortSignal
  readonly emit: (event: AgentEvent) => Promise<void>
  readonly tryEmit?: (event: AgentEvent) => boolean
  readonly recoveredResults?: ReadonlyMap<string, Required<ToolResult>>
  readonly rejection?: ToolResult
  readonly background?: {
    readonly afterMs: number
    readonly signal: AbortSignal
    readonly adopt: (call: BackgroundedCall) => void
  }
}

export interface DispatchOutput {
  readonly completions: ReadonlyArray<ToolCompleted>
  readonly paused: ReadonlyArray<ToolPaused>
}

export interface CallSettlement {
  readonly output: DispatchOutput
  readonly messages: ReadonlyArray<ChatMessage>
}

export interface BackgroundedCall {
  readonly call: PendingToolCall
  readonly settled: Promise<CallSettlement>
}

export const launchReceipt = (id: string): ChatMessage => ({
  role: ROLE.tool,
  message_id: `async-launch:${id}`,
  tool_call_id: id,
  async_tool_launch: { call_id: id },
  content:
    "This is still running in the background. Let the user know in a few words what you started, then end your turn; it will come back to you when it's done."
})

const SETTLEMENT = { event: "event", cancelled: "cancelled", backgrounded: "backgrounded" } as const

type Settlement =
  | { readonly kind: typeof SETTLEMENT.event; readonly event: ToolCompleted | ToolPaused }
  | { readonly kind: typeof SETTLEMENT.cancelled }
  | { readonly kind: typeof SETTLEMENT.backgrounded; readonly toolId: string }

const unexpectedMissingResult =
  "Tool result unexpectedly missing — this is an internal error, not proof the tool did not run. " +
  "Check the target's current state before retrying."

const argumentPreview: Record<ToolArgumentErrorCode, string> = {
  invalid_tool_arguments: "Invalid tool arguments",
  unavailable_tool: "Tool unavailable"
}

const sanitizeFailure = (
  call: PendingToolCall,
  failure?: ToolExecutionError
): Required<ToolResult> =>
  normalizeToolResult(
    failure === undefined
      ? {
          content:
            `Tool execution failed unexpectedly. Diagnostic reference: tool-call:${call.toolCall.id}. ` +
            "Check the target's current state before retrying.",
          preview: "Tool execution failed",
          is_error: true,
          retryable: false
        }
      : failedToolResult(failure)
  )

const toolRequest = (resolved: ResolvedCall, input: DispatchInput): ToolCallRequest => ({
  name: resolved.call.name,
  args: structuredClone(resolved.call.args),
  toolCallId: resolved.call.toolCall.id,
  signal: input.signal,
  messages: input.messages
})

export const decorateToolResult = (
  request: ToolCallRequest,
  result: ToolResult,
  toolset: Toolset
): Required<ToolResult> => {
  const normalized = normalizeToolResult(result)
  if (toolset.decorateResult === undefined) return normalized
  try {
    return normalizeToolResult(toolset.decorateResult(request, normalized))
  } catch {
    return normalized
  }
}

const appendResults = (
  messages: ChatMessage[],
  rawCalls: ReadonlyArray<ToolCall>,
  results: ReadonlyMap<string, string>,
  extras: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  modelContent: ReadonlyMap<string, ReadonlyArray<ContentBlock>>,
  missingContent: string,
  skipIds: ReadonlySet<string>,
  receiptIds: ReadonlySet<string> = new Set()
): void => {
  for (const call of rawCalls) {
    if (skipIds.has(call.id)) continue
    if (receiptIds.has(call.id)) {
      messages.push(launchReceipt(call.id))
      continue
    }
    const media = modelContent.get(call.id) ?? []
    messages.push({
      ...extras.get(call.id),
      message_id: messageId("tool"),
      role: ROLE.tool,
      tool_call_id: call.id,
      content: results.get(call.id) ?? missingContent,
      ...(media.length === 0 ? {} : { model_content: media })
    })
  }
}

const executeOne = async (
  resolved: ResolvedCall,
  input: DispatchInput,
  group: FairReadWriteLock,
  stateChanges: Semaphore
): Promise<Settlement> => {
  const changesState = resolved.meta.changes_state === true
  const unorder = changesState ? await stateChanges.acquire() : undefined
  try {
    return await executeInGroup(resolved, input, group, changesState)
  } finally {
    unorder?.()
  }
}

const executeInGroup = async (
  resolved: ResolvedCall,
  input: DispatchInput,
  group: FairReadWriteLock,
  changesState: boolean
): Promise<Settlement> => {
  const unlock = await group.acquire(changesState)
  let release: (() => void) | undefined
  let handedOff = false
  try {
    release = await input.semaphore.acquire()
    const startedAt = input.clock()
    const background =
      canRunInBackground(resolved.meta) && resolved.call.argumentError === undefined
        ? input.background
        : undefined
    if (background === undefined) return await executeCall(resolved, input, startedAt, {})
    const budget = foregroundBudget(background.afterMs)
    let moved = (): void => {}
    const backgrounded = new Promise<void>((resolve) => {
      moved = resolve
    })
    budget.phase(TOOL_PHASE.executing)
    const execution = executeCall(resolved, input, startedAt, {
      phase: budget.phase,
      backgrounded
    })
    const first = await Promise.race([execution, budget.expired])
    budget.stop()
    if (first !== FOREGROUND_EXPIRED) return first
    handedOff = true
    const finish = release
    void execution.finally(() => {
      finish()
      unlock()
    })
    moved()
    background.adopt({
      call: resolved.call,
      settled: execution.then((settlement) => backgroundSettlement(resolved, input, settlement))
    })
    return { kind: "backgrounded", toolId: resolved.call.toolCall.id }
  } finally {
    if (!handedOff) {
      release?.()
      unlock()
    }
  }
}

const executeCall = async (
  resolved: ResolvedCall,
  input: DispatchInput,
  startedAt: number,
  hooks: Pick<ToolCallRequest, "phase" | "backgrounded">
): Promise<Settlement> => {
  let settledCall = false
  const baseRequest = toolRequest(resolved, input)
  try {
    if (input.signal.aborted) return { kind: "cancelled" }
    await input.emit(started(resolved, startedAt))
    if (resolved.call.argumentError !== undefined) {
      const result = decorateToolResult(
        baseRequest,
        {
          content: resolved.call.argumentError.message,
          preview: argumentPreview[resolved.call.argumentError.code],
          is_error: true,
          retryable: false
        },
        input.toolset
      )
      const duration = Math.max(0, Math.trunc(input.clock() - startedAt))
      return { kind: "event", event: completed(resolved, result, duration) }
    }
    const progressSinkThatNeverThrowsIntoTool = (update: ToolProgressUpdate): void => {
      try {
        if (settledCall || input.signal.aborted) return
        if (typeof update?.message !== "string") return
        const event: AgentEvent = {
          _tag: "ToolProgress",
          depth: 0,
          parent_id: null,
          tool_call_id: resolved.call.toolCall.id,
          name: resolved.call.name,
          message: update.message,
          ...(update.data === undefined ? {} : { data: structuredClone(update.data) })
        }
        if (input.tryEmit !== undefined) input.tryEmit(event)
        else void input.emit(event).catch(() => undefined)
      } catch {}
    }
    const request: ToolCallRequest = {
      ...baseRequest,
      ...hooks,
      ...(input.beforeExecute === undefined ? {} : { beforeExecute: input.beforeExecute }),
      emit: progressSinkThatNeverThrowsIntoTool
    }
    const outcome = await applyToolCallMiddleware(
      request,
      async (current) => {
        const refusal = await current.beforeExecute?.()
        if (refusal !== undefined)
          return normalizeToolResult(
            await (input.toolset.settleRefusal?.(current, refusal) ?? refusal)
          )
        return normalizeToolResult(await input.toolset.execute(current))
      },
      input.middleware
    )
    const result = decorateToolResult(request, outcome, input.toolset)
    const duration = Math.max(0, Math.trunc(input.clock() - startedAt))
    return { kind: "event", event: completed(resolved, result, duration) }
  } catch (cause) {
    if (input.signal.aborted) return { kind: "cancelled" }
    const duration = Math.max(0, Math.trunc(input.clock() - startedAt))
    const failure = toToolFailure(cause)
    if (failure instanceof PauseRequested)
      return { kind: "event", event: paused(resolved, failure) }
    const result = decorateToolResult(
      baseRequest,
      sanitizeFailure(resolved.call, failure),
      input.toolset
    )
    return { kind: "event", event: completed(resolved, result, duration) }
  } finally {
    settledCall = true
  }
}

const FOREGROUND_EXPIRED = "expired"

const foregroundBudget = (afterMs: number) => {
  let timer: Timer | undefined
  let stopped = false
  let expire = (): void => {}
  const expired = new Promise<typeof FOREGROUND_EXPIRED>(
    (resolve) => (expire = () => resolve(FOREGROUND_EXPIRED))
  )
  return {
    expired,
    stop: (): void => {
      stopped = true
      timer?.cancel()
    },
    phase: (phase: ToolPhase): void => {
      timer?.cancel()
      if (stopped || phase === TOOL_PHASE.waiting || !Number.isFinite(afterMs)) return
      timer = after(afterMs, expire)
    }
  }
}

const backgroundSettlement = async (
  resolved: ResolvedCall,
  input: DispatchInput,
  settlement: Settlement
): Promise<CallSettlement> => {
  if (settlement.kind !== SETTLEMENT.event) throw abortError()
  const event = settlement.event
  await input.emit(event)
  const messages: ChatMessage[] = []
  if (isToolPaused(event)) return { output: { completions: [], paused: [event] }, messages }
  const id = event.tool_id
  appendResults(
    messages,
    [resolved.call.toolCall],
    new Map([[id, event.result]]),
    new Map(Object.keys(event.message_extras).length > 0 ? [[id, event.message_extras]] : []),
    new Map(event.model_content.length > 0 ? [[id, event.model_content]] : []),
    unexpectedMissingResult,
    new Set()
  )
  return { output: { completions: [event], paused: [] }, messages }
}

export const dispatchToolCalls = async (input: DispatchInput): Promise<DispatchOutput> => {
  const results = new Map<string, string>()
  const extras = new Map<string, Readonly<Record<string, unknown>>>()
  const modelContent = new Map<string, ReadonlyArray<ContentBlock>>()
  const pausedIds = new Set<string>()
  const backgroundedIds = new Set<string>()
  const completions: ToolCompleted[] = []
  const pausedEvents: ToolPaused[] = []
  const resolved = input.calls.map((call) => makeResolved(call, input.metas))

  for (const [toolId, result] of input.recoveredResults ?? []) {
    results.set(toolId, result.content)
    if (Object.keys(result.message_extras).length > 0) extras.set(toolId, result.message_extras)
    if (result.model_content.length > 0) modelContent.set(toolId, result.model_content)
  }

  const record = (event: ToolCompleted | ToolPaused): void => {
    if (isToolPaused(event)) {
      pausedIds.add(event.tool_id)
      pausedEvents.push(event)
      return
    }
    completions.push(event)
    results.set(event.tool_id, event.result)
    if (Object.keys(event.message_extras).length > 0)
      extras.set(event.tool_id, event.message_extras)
    if (event.model_content.length > 0) modelContent.set(event.tool_id, event.model_content)
  }

  const emitEvent = async (event: AgentEvent): Promise<void> => {
    await input.emit(event)
  }

  let aborted = false

  try {
    if (input.rejection !== undefined) {
      for (const item of resolved) {
        await emitEvent(started(item, input.clock()))
        const result = decorateToolResult(toolRequest(item, input), input.rejection, input.toolset)
        const event = completed(item, result, 0)
        record(event)
        await emitEvent(event)
      }
    } else {
      await runBatch()
    }
  } catch (cause) {
    if (input.signal.aborted || isAbortError(cause)) {
      aborted = true
      settle()
    }
    throw cause
  }
  settle()
  if (aborted) throw abortError()
  return { completions, paused: pausedEvents }

  function settle(): void {
    appendResults(
      input.messages,
      input.rawCalls,
      results,
      extras,
      modelContent,
      aborted || input.signal.aborted ? "Tool call cancelled." : unexpectedMissingResult,
      pausedIds,
      backgroundedIds
    )
  }

  async function runBatch(): Promise<void> {
    const groups = input.groups ?? new Map<string, FairReadWriteLock>()
    const stateChanges = input.stateChanges ?? makeSemaphore(1)
    const settled = new EventQueue<Settlement>(Number.POSITIVE_INFINITY)
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    if (input.signal.aborted) {
      aborted = true
      forwardAbort()
    } else input.signal.addEventListener("abort", forwardAbort, { once: true })
    const following: Array<Promise<unknown>> = []
    const background = input.background
    const batchInput: DispatchInput = {
      ...input,
      signal: controller.signal,
      ...(background === undefined
        ? {}
        : {
            background: {
              ...background,
              adopt: (call) => {
                following.push(call.settled)
                background.adopt(call)
              }
            }
          })
    }

    try {
      for (const item of resolved) {
        const key = item.meta.concurrency_group ?? item.call.name
        const group = groups.get(key) ?? makeFairReadWriteLock()
        groups.set(key, group)
        void executeOne(item, batchInput, group, stateChanges)
          .then((settlement) => settled.push(settlement))
          .catch(() => settled.push({ kind: "cancelled" }))
      }

      let remaining = resolved.length
      while (remaining > 0) {
        const next = await raceAbort(settled.next(), input.signal)
        if (next.done) break
        remaining -= 1
        if (next.value.kind === SETTLEMENT.cancelled) continue
        if (next.value.kind === SETTLEMENT.backgrounded) {
          backgroundedIds.add(next.value.toolId)
          continue
        }
        record(next.value.event)
        await emitEvent(next.value.event)
      }
    } catch (cause) {
      if (input.signal.aborted) {
        aborted = true
      } else {
        throw cause
      }
    } finally {
      input.signal.removeEventListener("abort", forwardAbort)
      if (background !== undefined && following.length > 0) {
        if (background.signal.aborted) forwardAbort()
        background.signal.addEventListener("abort", forwardAbort, { once: true })
        void Promise.allSettled(following).then(() =>
          background.signal.removeEventListener("abort", forwardAbort)
        )
      }
    }
  }
}
