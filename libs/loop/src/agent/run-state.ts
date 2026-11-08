import { StreamingTools, type StreamedToolResults } from "./streaming-tools.js"
import { BackgroundTools } from "./background-tools.js"
import { makeRunBudget } from "./budget.js"
import { makeSemaphore, type FairReadWriteLock, type Semaphore } from "../internal/concurrency.js"
import type { AgentConfig } from "./config.js"
import { dispatchToolCalls, type BackgroundedCall } from "../tools/dispatch.js"
import { AgentCallbackError } from "../errors.js"
import { applyJsonSchemaConverter } from "../tools/tool.js"
import { isConversationalInput, isHumanMessage, renderInteraction } from "./interactions.js"
import { makeToolSearch, type ToolSearchStrategy } from "../tools/search.js"
import { applyModelRequestMiddlewares } from "./middleware.js"
import { prepareProviderRequest, resolveModelCapabilities } from "./provider-capabilities.js"
import { runModelTurn } from "./model-turn.js"
import {
  messageId,
  type ChatMessage,
  type JsonObject,
  type Metadata,
  type ToolCall,
  type UserMessage
} from "../contracts/messages.js"
import type {
  PendingToolCall,
  ToolDeclaration,
  ToolMeta,
  ToolResult,
  ToolSearch,
  Toolset
} from "../contracts/tools.js"
import {
  addUsage,
  usageInputTokens,
  zeroUsage,
  type CompletionResponse,
  type ModelProvider,
  type ModelProviderRequest,
  type ModelRequest,
  type ResponseFormat,
  type Usage
} from "../contracts/provider.js"
import {
  StopReason,
  type AgentEvent,
  type AgentHooks,
  type AgentStreamEvent,
  type PendingToolRequest,
  type Result,
  type RunBudget,
  type ToolPaused
} from "../contracts/events.js"
import { budgetStopReason, loadedInHistory, withBudgetReminder } from "./policy.js"
import type { AgentOutputOptions } from "./structured-output.js"
import { callbackFailure, hookCall, invoke } from "./guards.js"
import { decodeMessages } from "../internal/validate.js"
import { makeHistoryJournal, type HistoryJournal } from "./history-journal.js"

export type AgentCostGetter = number | PromiseLike<number> | (() => number | PromiseLike<number>)

export interface AgentWiring {
  readonly config: AgentConfig
  readonly provider: ModelProvider
  readonly toolset: Toolset
  readonly hooks: AgentHooks
  readonly budget?: RunBudget
  readonly costCalculator?: (response: CompletionResponse) => number
  readonly costGetter?: AgentCostGetter
  readonly clock: () => number
  readonly persistHost?: (host: Metadata) => JsonObject
  readonly toolSearchStrategy?: ToolSearchStrategy
  readonly preloadTools?: ReadonlyArray<string>
}

export type Emit = (event: AgentStreamEvent) => Promise<void>

interface RunState {
  inputAdmission: { pending: boolean }
  streamedTools: StreamedToolResults
  readonly startedAtMs: number
  step: number
  resultText: string
  noProgressSteps: number
  usage: Usage
  localCost: number
  toolTimeMs: number
  lastResponse: CompletionResponse | null
  modelTurnCount: number
  structuredObject: { readonly value: unknown } | null
  outputCorrectionUsed: boolean
  finalTextChecked: boolean
  deferredNames: ReadonlySet<string> | undefined
}

export interface Run {
  readonly wiring: AgentWiring
  readonly messages: ChatMessage[]
  readonly history: HistoryJournal
  readonly state: RunState
  readonly budget: RunBudget
  readonly signal: AbortSignal
  readonly emit: Emit
  readonly tryEmit?: (event: AgentEvent) => boolean
  readonly output?: AgentOutputOptions
  readonly responseFormat: ResponseFormat | null
  readonly semaphore: Semaphore
  readonly groups: Map<string, FairReadWriteLock>
  readonly stateChanges: Semaphore
  readonly toolsController: AbortController
  readonly toolSignal: AbortSignal
  readonly backgroundSignal: AbortSignal
  readonly detachBackground: () => void
  readonly background: BackgroundTools
}

export type StepView = Omit<ModelRequest, "step" | "previousResponse" | "compactionReplacement"> & {
  readonly toolSearch?: ToolSearch
  readonly metas: ReadonlyMap<string, ToolMeta>
  readonly asyncMode: "native" | "message"
}

export const makeRun = (input: {
  readonly wiring: AgentWiring
  readonly sourceMessages: ReadonlyArray<ChatMessage>
  readonly emit: Emit
  readonly signal: AbortSignal
  readonly output: AgentOutputOptions | undefined
  readonly tryEmit: ((event: AgentEvent) => boolean) | undefined
}): Run => {
  const { wiring, signal, output } = input
  const history = makeHistoryJournal(decodeMessages(input.sourceMessages))
  const { messages } = history
  const state: RunState = {
    inputAdmission: { pending: false },
    startedAtMs: invoke("clock", wiring.clock),
    step: 0,
    resultText: "",
    noProgressSteps: 0,
    usage: zeroUsage(),
    localCost: 0,
    toolTimeMs: 0,
    lastResponse: null,
    modelTurnCount: 0,
    streamedTools: { ids: new Set(), output: { completions: [], paused: [] } },
    structuredObject: null,
    outputCorrectionUsed: false,
    finalTextChecked: false,
    deferredNames: undefined
  }
  const responseFormat: ResponseFormat | null =
    output === undefined
      ? null
      : {
          name: output.name ?? "output",
          schema: invoke("output.toJsonSchema", () =>
            applyJsonSchemaConverter(output.toJsonSchema, output.schema)
          )
        }
  const toolsController = new AbortController()
  const backgroundController = new AbortController()
  const stopBackground = () => backgroundController.abort()
  if (signal.aborted) stopBackground()
  signal.addEventListener("abort", stopBackground, { once: true })
  toolsController.signal.addEventListener("abort", stopBackground, { once: true })
  const background = new BackgroundTools({
    messages,
    signal,
    clock: () => invoke("clock", wiring.clock),
    graceMs: wiring.config.backgroundGraceMs,
    capacity: wiring.config.maxToolConcurrency,
    checkpoint: () =>
      history.checkpoint((current, change) =>
        hookCall("onCheckpoint", () => wiring.hooks.onCheckpoint?.(current, change))
      ),
    stop: stopBackground,
    execute: ({ call, messages: isolated, metas, recovered, rejection }) =>
      runTools(run, recovered === undefined ? [call] : [], [call.toolCall], metas, {
        messages: isolated,
        signal: run.backgroundSignal,
        ...(rejection === undefined ? {} : { rejection }),
        ...(recovered === undefined
          ? {}
          : { recoveredResults: new Map([[call.toolCall.id, recovered]]) })
      })
  })
  const run: Run = {
    wiring,
    messages,
    history,
    state,
    budget: wiring.budget ?? makeRunBudget(),
    signal,
    emit: input.emit,
    ...(input.tryEmit === undefined ? {} : { tryEmit: input.tryEmit }),
    ...(output === undefined ? {} : { output }),
    responseFormat,
    semaphore: makeSemaphore(wiring.config.maxToolConcurrency),
    groups: new Map(),
    stateChanges: makeSemaphore(1),
    toolsController,
    toolSignal: AbortSignal.any([signal, toolsController.signal]),
    backgroundSignal: backgroundController.signal,
    detachBackground: () => {
      signal.removeEventListener("abort", stopBackground)
      toolsController.signal.removeEventListener("abort", stopBackground)
    },
    background
  }
  return run
}

const currentCost = async (run: Run): Promise<number> => {
  const getter = run.wiring.costGetter
  if (getter === undefined) return run.state.localCost
  let cost: number
  try {
    cost = await (typeof getter === "function" ? getter() : getter)
  } catch (cause) {
    throw callbackFailure("costGetter", cause)
  }
  if (!Number.isFinite(cost) || cost < 0) {
    throw callbackFailure("costGetter", new RangeError("cost must be finite and non-negative"))
  }
  return cost
}

export const stopForBudget = async (run: Run): Promise<StopReason | null> => {
  const snapshot = await run.budget.snapshot()
  const nowMs = invoke("clock", run.wiring.clock)
  const cost = await currentCost(run)
  return budgetStopReason({
    config: run.wiring.config,
    budget: snapshot,
    startedAtMs: run.state.startedAtMs,
    nowMs,
    cost
  })
}

const result = async (
  run: Run,
  text: string,
  reason: StopReason,
  steps: number,
  pausedTools: ReadonlyArray<PendingToolRequest>
): Promise<Result> => {
  const { wiring, state, messages } = run
  const fallback = wiring.config.policy.fallbackResultText
  const finalText =
    reason !== StopReason.END_TURN &&
    reason !== StopReason.PAUSED &&
    text.trim().length === 0 &&
    fallback !== undefined
      ? invoke("policy.fallbackResultText", () => fallback(messages, reason) || text)
      : text
  const nowMs = invoke("clock", wiring.clock)
  const cost = await currentCost(run)
  state.resultText = finalText
  return {
    text: finalText,
    ...(state.structuredObject === null ? {} : { object: state.structuredObject.value }),
    stop_reason: reason,
    steps,
    usage: state.usage,
    last_input_tokens:
      state.lastResponse === null ? null : usageInputTokens(state.lastResponse.usage),
    cost,
    duration_ms: Math.max(0, Math.trunc(nowMs - state.startedAtMs)),
    tool_time_ms: state.toolTimeMs,
    paused_tools: [...pausedTools],
    messages: messages.map((message) => structuredClone(message))
  }
}

export const finalize = async (
  run: Run,
  text: string,
  reason: StopReason,
  steps: number,
  pausedTools: ReadonlyArray<PendingToolRequest> = []
): Promise<void> => {
  run.toolsController.abort()
  await run.emit(await result(run, text, reason, steps, pausedTools))
}

export const pauseResult = (paused: ReadonlyArray<ToolPaused>): ReadonlyArray<PendingToolRequest> =>
  paused.map((event) => ({
    tool_call_id: event.tool_id,
    name: event.name,
    args: { ...event.args },
    reason: event.reason,
    detail: event.detail
  }))

export const stepFinished = (run: Run): Promise<void> =>
  run.history.checkpoint((messages, change) =>
    hookCall("onStepFinish", () =>
      run.wiring.hooks.onStepFinish?.(run.state.step, run.state.lastResponse, messages, change)
    )
  )

export const drainPending = async (run: Run): Promise<number> => {
  const pending = await hookCall(
    "getPendingMessages",
    () => run.wiring.hooks.getPendingMessages?.() ?? []
  )
  if (pending.length === 0) return 0
  const valid = decodeMessages(pending)
  if (valid.some(isConversationalInput)) run.state.inputAdmission.pending = true
  run.messages.push(...valid)
  if (valid.some((message) => isOwnerMessage(run, message))) await announceInputTaken(run)
  return valid.length
}

export const isOwnerMessage = (run: Run, message: ChatMessage): boolean =>
  (run.wiring.hooks.isOwnerMessage ?? isHumanMessage)(message)

export const announceInputTaken = (run: Run): Promise<void> =>
  run.emit({ _tag: "InputTaken", depth: 0, parent_id: null })

export const prepare = async (run: Run): Promise<StepView> => {
  const { wiring, state, messages } = run
  const entries = await wiring.toolset.entries()
  const loaded = new Set([...(await wiring.toolset.loadedNames()), ...loadedInHistory(messages)])
  const visible: Array<ToolDeclaration> = []
  const deferred: Array<ToolDeclaration> = []
  for (const entry of entries) {
    const declaration: ToolDeclaration = {
      name: entry.meta.name,
      description: entry.description,
      parameters: entry.parameters,
      ...(entry.meta.hosted === true ? { hosted: true } : {}),
      ...(entry.meta.group === undefined ? {} : { group: entry.meta.group })
    }
    if (entry.meta.deferred === true) deferred.push(declaration)
    else visible.push(declaration)
  }
  const searches =
    (await resolveModelCapabilities({ provider: wiring.provider, model: wiring.config.model }))
      .toolSearch === "client"
  const changed = searches ? toolsChangedRecord(state.deferredNames, deferred) : undefined
  state.deferredNames = new Set(deferred.map((tool) => tool.name))
  if (changed !== undefined) {
    messages.push(changed)
    for (const name of changed.removed_tools ?? []) loaded.delete(name)
  }
  const preload =
    searches && wiring.preloadTools !== undefined
      ? preloadRecord(wiring.preloadTools, deferred, loaded)
      : undefined
  if (preload !== undefined) {
    messages.push(preload)
    for (const name of preload.loaded_tools ?? []) loaded.add(name)
  }
  const request: ModelRequest = {
    step: state.step,
    messages,
    model: wiring.config.model,
    ...(wiring.config.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: wiring.config.maxOutputTokens }),
    tools: visible,
    deferredTools: deferred,
    toolChoice: wiring.config.toolChoice,
    ...(wiring.config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: wiring.config.reasoningEffort }),
    ...(wiring.config.cacheScope === undefined ? {} : { cacheScope: wiring.config.cacheScope }),
    ...(run.responseFormat === null ? {} : { responseFormat: run.responseFormat }),
    previousResponse: state.lastResponse
  }
  const prepared = await prepareProviderRequest({
    provider: wiring.provider,
    request: await applyModelRequestMiddlewares(request, wiring.config.modelRequestMiddlewares),
    entries
  })
  const carried =
    prepared.compactionReplacement !== undefined && prepared.compactionReplacement !== messages
      ? carryLoadedTools(decodeMessages(prepared.compactionReplacement), loaded, prepared)
      : undefined
  if (carried !== undefined) messages.splice(0, messages.length, ...carried.history)
  const metas = new Map(entries.map((entry) => [entry.meta.name, entry.meta]))
  return {
    ...(prepared.deferredTools.length === 0
      ? {}
      : {
          toolSearch: makeToolSearch({
            catalog: prepared.deferredTools.map((declaration) => ({
              declaration,
              meta: metas.get(declaration.name) ?? { name: declaration.name }
            })),
            loaded,
            ...(wiring.toolSearchStrategy === undefined
              ? {}
              : { strategy: wiring.toolSearchStrategy })
          })
        }),
    messages:
      carried?.record === undefined ? prepared.messages : [...prepared.messages, carried.record],
    model: prepared.model,
    ...(prepared.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: prepared.maxOutputTokens }),
    tools: prepared.tools,
    deferredTools: prepared.deferredTools,
    toolChoice: prepared.toolChoice,
    ...(prepared.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: prepared.reasoningEffort }),
    ...(prepared.cacheScope === undefined ? {} : { cacheScope: prepared.cacheScope }),
    ...(prepared.responseFormat === undefined ? {} : { responseFormat: prepared.responseFormat }),
    asyncMode:
      (await resolveModelCapabilities({ provider: wiring.provider, model: prepared.model }))
        .asyncTools ?? "message",
    metas
  }
}

type DeveloperRecord = ChatMessage & { readonly role: "developer" }

const appendOnlyToolRecord = (
  kind: "tool-change" | "tool-load",
  content: string,
  tools:
    | { readonly removed_tools: ReadonlyArray<string> }
    | { readonly loaded_tools: ReadonlyArray<string> }
    | undefined = undefined
): DeveloperRecord => ({
  message_id: messageId(kind),
  role: "developer",
  is_meta: true,
  content,
  ...tools
})

const toolsChangedRecord = (
  previous: ReadonlySet<string> | undefined,
  deferred: ReadonlyArray<ToolDeclaration>
): DeveloperRecord | undefined => {
  if (previous === undefined) return undefined
  const current = new Set(deferred.map((tool) => tool.name))
  const added = [...current].filter((name) => !previous.has(name)).sort()
  const removed = [...previous].filter((name) => !current.has(name)).sort()
  if (added.length === 0 && removed.length === 0) return undefined
  return appendOnlyToolRecord(
    "tool-change",
    [
      "Tools changed in this conversation.",
      ...(added.length === 0 ? [] : [`Now found by tool search: ${added.join(", ")}.`]),
      ...(removed.length === 0 ? [] : [`No longer available: ${removed.join(", ")}.`])
    ].join(" "),
    removed.length === 0 ? undefined : { removed_tools: removed }
  )
}

const preloadRecord = (
  names: ReadonlyArray<string>,
  deferred: ReadonlyArray<ToolDeclaration>,
  loaded: ReadonlySet<string>
): DeveloperRecord | undefined => {
  const catalog = new Set(deferred.map((tool) => tool.name))
  const missing = [...new Set(names)]
    .filter((name) => catalog.has(name) && !loaded.has(name))
    .sort()
  if (missing.length === 0) return undefined
  return appendOnlyToolRecord(
    "tool-load",
    `Tools loaded for this conversation: ${missing.join(", ")}.`,
    { loaded_tools: missing }
  )
}

const carryLoadedTools = (
  replacement: ReadonlyArray<ChatMessage>,
  loaded: ReadonlySet<string>,
  prepared: ModelRequest
): { readonly history: ReadonlyArray<ChatMessage>; readonly record?: ChatMessage } => {
  const deferred = new Set(prepared.deferredTools.map((tool) => tool.name))
  const kept = loadedInHistory(replacement)
  const names = [...loaded].filter((name) => deferred.has(name) && !kept.has(name)).sort()
  if (names.length === 0) return { history: replacement }
  const record = appendOnlyToolRecord(
    "tool-load",
    `Tools still loaded from earlier in this conversation: ${names.join(", ")}.`,
    { loaded_tools: names }
  )
  return { history: [...replacement, record], record }
}

export const callModel = async (run: Run, view: StepView, instruction: string | null = null) => {
  const { wiring, state, messages } = run
  const requestSnapshot = [...view.messages]
  const requestMessages =
    instruction === null ? requestSnapshot : withBudgetReminder(requestSnapshot, instruction)
  const steeringInput: ChatMessage[] = []
  const historyGate = makeSemaphore(1)
  const withHistory = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = await historyGate.acquire()
    try {
      return await operation()
    } finally {
      release()
    }
  }
  const request: ModelProviderRequest = {
    steering: {
      take: () =>
        withHistory(async () => {
          const pending = decodeMessages(
            await hookCall("getPendingMessages", () => wiring.hooks.getPendingMessages?.() ?? [])
          )
          steeringInput.push(...pending)
          messages.push(...pending)
          if (pending.length > 0)
            await run.history.checkpoint((current, change) =>
              hookCall("onCheckpoint", () => wiring.hooks.onCheckpoint?.(current, change))
            )
          return pending.filter(
            (message): message is UserMessage => message.role === "user" && message.is_meta !== true
          )
        })
    },
    messages: requestMessages,
    renderInteraction,
    model: view.model,
    ...(view.maxOutputTokens === undefined ? {} : { maxOutputTokens: view.maxOutputTokens }),
    tools: view.tools,
    deferredTools: view.deferredTools,
    ...(view.toolSearch === undefined ? {} : { toolSearch: view.toolSearch }),
    toolChoice: view.toolChoice,
    ...(view.reasoningEffort === undefined ? {} : { reasoningEffort: view.reasoningEffort }),
    ...(view.cacheScope === undefined ? {} : { cacheScope: view.cacheScope }),
    ...(view.responseFormat === undefined ? {} : { responseFormat: view.responseFormat }),
    signal: run.signal
  }
  const minter = wiring.config.mintMessageId
  const turnIndex = state.modelTurnCount
  state.modelTurnCount += 1
  const streaming = new StreamingTools({
    run,
    view,
    canStart: async () => (await stopForBudget(run)) === null,
    execute: (call, isolated) =>
      runTools(run, [call], [call.toolCall], view.metas, {
        messages: isolated,
        foreground: true
      })
  })
  const turn = await runModelTurn({
    commitOutput: withHistory,
    onToolCallReady: (call, checkpoint) => streaming.start(call, checkpoint),
    checkpoint: () =>
      run.history.checkpoint((current, change) =>
        hookCall("onCheckpoint", () => wiring.hooks.onCheckpoint?.(current, change))
      ),
    provider: wiring.provider,
    request,
    history: messages,
    metas: view.metas,
    emit: (event) => run.emit(event),
    ...(wiring.toolset.displayTitle === undefined
      ? {}
      : { displayTitle: wiring.toolset.displayTitle }),
    ...(wiring.persistHost === undefined ? {} : { persistHost: wiring.persistHost }),
    ...(minter === undefined
      ? {}
      : {
          mintMessageId: (kind, position) => minter(kind, { turn: turnIndex, ...position })
        })
  })
  state.lastResponse = turn.response
  state.usage = addUsage(state.usage, turn.response.usage)
  await run.budget.addOutputTokens(turn.response.usage.completion_tokens)
  const costCalculator = wiring.costCalculator
  if (costCalculator !== undefined) {
    const added = invoke("costCalculator", () => costCalculator(turn.response))
    if (!Number.isFinite(added) || added < 0) {
      throw new AgentCallbackError(
        "costCalculator",
        "costCalculator returned a non-finite or negative cost"
      )
    }
    state.localCost += added
  }
  await run.history.checkpoint((current, change) =>
    hookCall("onResponse", () => wiring.hooks.onResponse?.(turn.response, current, change))
  )
  state.streamedTools = await streaming.settle()
  return steeringInput.length === 0
    ? turn
    : { ...turn, response: { ...turn.response, continuation: true } }
}

export const runTools = async (
  run: Run,
  calls: ReadonlyArray<PendingToolCall>,
  rawCalls: ReadonlyArray<ToolCall>,
  metas: ReadonlyMap<string, ToolMeta>,
  options: {
    readonly messages?: ChatMessage[]
    readonly recoveredResults?: ReadonlyMap<string, Required<ToolResult>>
    readonly rejection?: ToolResult
    readonly foreground?: boolean
    readonly signal?: AbortSignal
  } = {}
) => {
  const { wiring, toolSignal } = run
  const admission = run.state.inputAdmission
  const adopt = (backgrounded: BackgroundedCall): void => {
    run.background.adopt(backgrounded)
    void backgrounded.settled.then(
      (settled) => {
        for (const completion of settled.output.completions)
          run.state.toolTimeMs += completion.duration_ms
      },
      () => undefined
    )
  }
  const output = await dispatchToolCalls({
    messages: options.messages ?? run.messages,
    calls,
    rawCalls,
    metas,
    toolset: wiring.toolset,
    middleware: wiring.config.toolCallMiddlewares,
    beforeExecute: async () => {
      if (
        !admission.pending &&
        (await hookCall("hasPendingInput", () => wiring.hooks.hasPendingInput?.() ?? false))
      )
        admission.pending = true
      return admission.pending
        ? {
            content:
              "This call was not started because new input is waiting. Read that input before deciding the next action.",
            preview: "Not started: new input",
            is_error: true,
            retryable: true
          }
        : undefined
    },
    semaphore: run.semaphore,
    groups: run.groups,
    stateChanges: run.stateChanges,
    clock: wiring.clock,
    signal: options.signal ?? toolSignal,
    emit: (event) => (toolSignal.aborted ? Promise.resolve() : run.emit(event)),
    ...(run.tryEmit === undefined ? {} : { tryEmit: run.tryEmit }),
    ...(options.recoveredResults === undefined
      ? {}
      : { recoveredResults: options.recoveredResults }),
    ...(options.rejection === undefined ? {} : { rejection: options.rejection }),
    ...(options.foreground === true
      ? {
          background: {
            afterMs: wiring.config.foregroundBudgetMs,
            signal: run.backgroundSignal,
            adopt
          }
        }
      : {})
  })
  for (const completion of output.completions) run.state.toolTimeMs += completion.duration_ms
  return output
}
