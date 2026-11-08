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
  callEndsTurn,
  canRunInBackground,
  type PendingToolCall,
  type ToolArgumentError,
  type ToolArgumentErrorCode,
  type ToolCallMiddleware,
  type ToolCallRequest,
  type ToolDisplayTitle,
  type ToolMeta,
  type ToolPhase,
  type ToolProgressUpdate,
  type ToolResult,
  type Toolset
} from "../contracts/tools.js"
import type { AgentEvent, ToolCompleted, ToolPaused, ToolStarted } from "../contracts/events.js"
import { EventQueue } from "../internal/stream.js"
import { normalizeToolResult } from "../internal/validate.js"
import { sanitizeToolDisplayTitle, splitToolArguments } from "./display-title.js"
import { errorMessage } from "@arden-hq/std/errors"
import { isRecord } from "@arden-hq/std/json"

const invalidArguments = (message: string): ToolArgumentError => ({
  code: "invalid_tool_arguments",
  message
})

const malformedJsonMessage = (source: string, cause: unknown): string => {
  const detail = errorMessage(cause)
  return (
    `Malformed JSON at character ${malformedJsonPosition(source, detail)}: ${normalizedJsonError(detail)}. ` +
    "Retry the tool call with one valid JSON object matching its schema."
  )
}

const expectsPropertyName = /(?:property name|property\s+name|expected ['"]?\})/i

const malformedJsonPosition = (source: string, detail: string): number => {
  const explicitPosition = /position\s+(\d+)/i.exec(detail)?.[1]
  if (explicitPosition !== undefined) return Number(explicitPosition)
  if (/(?:unexpected\s+(?:eof|end)|unexpected end)/i.test(detail)) return source.length
  if (expectsPropertyName.test(detail)) {
    return Math.max(0, Math.max(source.lastIndexOf(","), source.lastIndexOf("{")) + 1)
  }
  return 0
}

const normalizedJsonError = (detail: string): string => {
  if (expectsPropertyName.test(detail)) return "Expecting property name enclosed in double quotes"
  if (/(?:unexpected\s+(?:eof|end))/i.test(detail)) return "Expecting value"
  return detail.replace(/\s+at position\s+\d+.*$/i, "")
}

const nonObjectArguments = (): ToolArgumentError =>
  invalidArguments(
    "Tool arguments must be a JSON object. Retry the tool call with one valid JSON object matching its schema."
  )

/** Parse provider tool arguments without throwing or accepting arrays/primitives. */
export const parseToolCalls = (
  calls: ReadonlyArray<ToolCall>,
  displayTitleArgument: ToolDisplayTitle | undefined
): ReadonlyArray<PendingToolCall> =>
  calls.map((toolCall) => {
    if (toolCall.function.arguments.length === 0) {
      const displayTitle =
        displayTitleArgument === undefined
          ? undefined
          : sanitizeToolDisplayTitle(toolCall.display_title, displayTitleArgument)
      return {
        toolCall,
        name: toolCall.function.name,
        args: {},
        ...(displayTitle === undefined ? {} : { displayTitle })
      }
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(toolCall.function.arguments)
    } catch (cause) {
      return {
        toolCall,
        name: toolCall.function.name,
        args: {},
        argumentError: invalidArguments(malformedJsonMessage(toolCall.function.arguments, cause))
      }
    }
    if (!isRecord(decoded)) {
      return {
        toolCall,
        name: toolCall.function.name,
        args: {},
        argumentError: nonObjectArguments()
      }
    }
    const projected = splitToolArguments(decoded, toolCall.display_title, displayTitleArgument)
    return {
      toolCall,
      name: toolCall.function.name,
      args: projected.args,
      ...(projected.displayTitle === undefined ? {} : { displayTitle: projected.displayTitle })
    }
  })

const visibleToolList = (visibleNames: ReadonlyArray<string>): string => {
  if (visibleNames.length === 0) return "none"
  return visibleNames.length <= 10
    ? visibleNames.join(", ")
    : `${visibleNames.slice(0, 10).join(", ")}, ... (${visibleNames.length} tools total)`
}

export const gateUnavailableCalls = (
  calls: ReadonlyArray<PendingToolCall>,
  advertisedNames: ReadonlySet<string>,
  visibleNames: ReadonlyArray<string>
): ReadonlyArray<PendingToolCall> => {
  const visible = visibleToolList(visibleNames)
  return calls.map((call) =>
    call.argumentError !== undefined || advertisedNames.has(call.name)
      ? call
      : {
          ...call,
          argumentError: {
            code: "unavailable_tool" as const,
            message: `Tool '${call.name}' is not available in this step: it is not in the current tool list. Use one of: ${visible}.`
          }
        }
  )
}

export interface DispatchInput {
  readonly messages: ChatMessage[]
  readonly calls: ReadonlyArray<PendingToolCall>
  readonly rawCalls: ReadonlyArray<ToolCall>
  readonly metas: ReadonlyMap<string, ToolMeta>
  readonly toolset: Toolset
  readonly beforeExecute?: () => Promise<ToolResult | undefined>
  readonly middleware: ReadonlyArray<ToolCallMiddleware>
  readonly groups?: Map<string, FairReadWriteLock>
  /** One permit, shared by the run: state-changing calls run one at a time,
   *  in the order they reach dispatch (the order the model asked for them). */
  readonly stateChanges?: Semaphore
  readonly semaphore: Semaphore
  readonly clock: () => number
  readonly signal: AbortSignal
  readonly emit: (event: AgentEvent) => Promise<void>
  /** Lossy, non-suspending emit for progress; a full buffer drops the event. */
  readonly tryEmit?: (event: AgentEvent) => boolean
  readonly recoveredResults?: ReadonlyMap<string, Required<ToolResult>>
  readonly rejection?: ToolResult
  /**
   * A call that can run in the background and is still executing `afterMs`
   * after its effect began moves there: the batch settles it with a launch
   * receipt and hands the in-flight call to `adopt`.
   */
  readonly background?: {
    readonly afterMs: number
    /** Stops moved calls once their batch has ended. */
    readonly signal: AbortSignal
    readonly adopt: (call: BackgroundedCall) => void
  }
}

export interface DispatchOutput {
  readonly completions: ReadonlyArray<ToolCompleted>
  readonly paused: ReadonlyArray<ToolPaused>
}

/** What one call settles into: its events and the history records it appends. */
export interface CallSettlement {
  readonly output: DispatchOutput
  readonly messages: ReadonlyArray<ChatMessage>
}

/** A call moved to the background mid-execution; `settled` follows the same call. */
export interface BackgroundedCall {
  readonly call: PendingToolCall
  readonly settled: Promise<CallSettlement>
}

/** The portable receipt that closes a background call on the wire; its result arrives later. */
export const launchReceipt = (id: string): ChatMessage => ({
  role: "tool",
  message_id: `async-launch:${id}`,
  tool_call_id: id,
  async_tool_launch: { call_id: id, delivery: "message" },
  content: JSON.stringify({
    status: "running",
    tool_call_id: id,
    instruction:
      "Continue independent work. The tool result will arrive in an internal completion message."
  })
})

interface ResolvedCall {
  readonly call: PendingToolCall
  readonly meta: ToolMeta
}

type Settlement =
  | { readonly kind: "event"; readonly event: ToolCompleted | ToolPaused }
  | { readonly kind: "cancelled" }
  /** Still running after the foreground budget; settles later in the background. */
  | { readonly kind: "backgrounded"; readonly toolId: string }

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

/** Decoration is advisory and must never erase an already-settled tool outcome. */
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

const makeResolved = (
  call: PendingToolCall,
  metas: ReadonlyMap<string, ToolMeta>
): ResolvedCall => ({
  call,
  meta: metas.get(call.name) ?? { name: call.name }
})

const callHost = (resolved: ResolvedCall): Readonly<Record<string, unknown>> => ({
  ...(resolved.meta.host ?? {}),
  ...(resolved.call.displayTitle === undefined ? {} : { display_title: resolved.call.displayTitle })
})

const started = (resolved: ResolvedCall, timestamp: number): ToolStarted => ({
  timestamp,
  _tag: "ToolStarted",
  depth: 0,
  parent_id: null,
  tool_id: resolved.call.toolCall.id,
  name: resolved.call.name,
  args: { ...resolved.call.args },
  host: callHost(resolved)
})

const completed = (
  resolved: ResolvedCall,
  result: ToolResult,
  durationMs: number
): ToolCompleted => ({
  _tag: "ToolCompleted",
  depth: 0,
  parent_id: null,
  tool_id: resolved.call.toolCall.id,
  name: resolved.call.name,
  result: result.content,
  preview: result.preview,
  duration_ms: durationMs,
  is_error: result.is_error ?? false,
  data: result.data ?? null,
  retryable: result.retryable ?? null,
  message_extras: { ...(result.message_extras ?? {}) },
  host: { ...callHost(resolved), ...(result.host ?? {}) },
  model_content: result.model_content ?? [],
  ends_turn: callEndsTurn(resolved.meta, resolved.call.args)
})

const paused = (resolved: ResolvedCall, pause: PauseRequested): ToolPaused => ({
  _tag: "ToolPaused",
  depth: 0,
  parent_id: null,
  tool_id: resolved.call.toolCall.id,
  name: resolved.call.name,
  args: { ...resolved.call.args },
  reason: pause.reason,
  detail: pause.detail ?? ""
})

const appendResults = (
  messages: ChatMessage[],
  rawCalls: ReadonlyArray<ToolCall>,
  results: ReadonlyMap<string, string>,
  extras: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
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
    messages.push({
      ...extras.get(call.id),
      message_id: messageId("tool"),
      role: "tool",
      tool_call_id: call.id,
      content: results.get(call.id) ?? missingContent
    })
  }
}

const appendModelContent = (
  messages: ChatMessage[],
  rawCalls: ReadonlyArray<ToolCall>,
  content: ReadonlyMap<string, ReadonlyArray<ContentBlock>>
): void => {
  for (const call of rawCalls) {
    const blocks = content.get(call.id)
    if (blocks === undefined || blocks.length === 0) continue
    messages.push({
      message_id: messageId("tool-media"),
      role: "user",
      client_id: `tool-media:${call.id}`,
      is_meta: true,
      content: [
        {
          type: "context",
          content_type: "tool_result_media",
          content: `Media returned by tool ${call.function.name}.`,
          metadata: {
            tool_call_id: call.id,
            tool_name: call.function.name
          }
        },
        ...blocks
      ] as unknown as ReadonlyArray<Record<string, unknown>>
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
    budget.phase("executing")
    const execution = executeCall(resolved, input, startedAt, {
      phase: budget.phase,
      backgrounded
    })
    const first = await Promise.race([execution, budget.expired])
    budget.stop()
    if (first !== "expired") return first
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
    const progress = (update: ToolProgressUpdate): void => {
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
      } catch {
        // emit is a contract-free sink: a failing consumer never reaches the tool.
      }
    }
    const request: ToolCallRequest = {
      ...baseRequest,
      ...hooks,
      ...(input.beforeExecute === undefined ? {} : { beforeExecute: input.beforeExecute }),
      emit: progress
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

const foregroundBudget = (afterMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let expire = (): void => {}
  const expired = new Promise<"expired">((resolve) => {
    expire = () => resolve("expired")
  })
  return {
    expired,
    stop: (): void => {
      stopped = true
      clearTimeout(timer)
    },
    phase: (phase: ToolPhase): void => {
      clearTimeout(timer)
      if (stopped || phase === "waiting" || !Number.isFinite(afterMs)) return
      timer = setTimeout(expire, afterMs)
    }
  }
}

const backgroundSettlement = async (
  resolved: ResolvedCall,
  input: DispatchInput,
  settlement: Settlement
): Promise<CallSettlement> => {
  if (settlement.kind !== "event") throw abortError()
  const event = settlement.event
  await input.emit(event)
  const messages: ChatMessage[] = []
  if (event._tag === "ToolPaused") return { output: { completions: [], paused: [event] }, messages }
  const id = event.tool_id
  appendResults(
    messages,
    [resolved.call.toolCall],
    new Map([[id, event.result]]),
    new Map(Object.keys(event.message_extras).length > 0 ? [[id, event.message_extras]] : []),
    unexpectedMissingResult,
    new Set()
  )
  appendModelContent(
    messages,
    [resolved.call.toolCall],
    new Map(event.model_content.length > 0 ? [[id, event.model_content]] : [])
  )
  return { output: { completions: [event], paused: [] }, messages }
}

/**
 * Execute and settle one tool batch into the loop's private history.
 * All starts are emitted before any execution; settlements stream in
 * completion order. Paused calls deliberately receive no tool-result
 * message so recovery can see the trailing incomplete assistant step.
 */
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
    if (event._tag === "ToolPaused") {
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
      aborted || input.signal.aborted ? "Tool call cancelled." : unexpectedMissingResult,
      pausedIds,
      backgroundedIds
    )
    appendModelContent(input.messages, input.rawCalls, modelContent)
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
        if (next.value.kind === "cancelled") continue
        if (next.value.kind === "backgrounded") {
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
