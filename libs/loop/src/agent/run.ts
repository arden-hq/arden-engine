import { isBackgroundCall } from "./streaming-tools.js"
import { pendingBackgroundCalls } from "./background-tools.js"
import { isAbortError } from "../abort.js"
import { decorateToolResult, type DispatchOutput } from "../tools/dispatch.js"
import { admitToolCalls, loadDeferredCalls } from "./tool-admission.js"
import { StructuredOutputError } from "../errors.js"
import { messageId, type ChatMessage } from "../contracts/messages.js"
import { ToolChoice, type ProviderMessage } from "../contracts/provider.js"
import { StopReason, type AgentEvent, type ToolPaused } from "../contracts/events.js"
import { incompleteToolStep } from "./recovery.js"
import { normalizeToolResult } from "../internal/validate.js"
import { hookCall, invoke } from "./guards.js"
import {
  appendBudgetDenials,
  budgetDenialResult,
  nextNoProgressCount,
  recoveredTerminalText,
  terminalCompletionText,
  turnEndingToolBatchRejection,
  turnEndingBatchRefusal
} from "./policy.js"
import {
  announceInputTaken,
  callModel,
  drainPending,
  finalize,
  isOwnerMessage,
  makeRun,
  pauseResult,
  prepare,
  runTools,
  stepFinished,
  stopForBudget,
  type AgentWiring,
  type Emit,
  type Run,
  type StepView
} from "./run-state.js"
import {
  correctionContent,
  formatIssues,
  validateOutputText,
  type AgentOutputOptions
} from "./structured-output.js"

type StepOutcome = "continue" | "done"

export const runLoop = async (
  wiring: AgentWiring,
  sourceMessages: ReadonlyArray<ChatMessage>,
  emit: Emit,
  signal: AbortSignal,
  output?: AgentOutputOptions,
  tryEmit?: (event: AgentEvent) => boolean
): Promise<void> => {
  const run = makeRun({ wiring, sourceMessages, emit, signal, output, tryEmit })
  let failure: unknown
  let failed = false
  try {
    await launchPendingBackground(run)
    if (await resumeIncomplete(run)) return
    while (true) {
      if ((await step(run)) === "done") return
    }
  } catch (cause) {
    failed = true
    failure = cause
    if (!(isAbortError(cause) || signal.aborted)) {
      await hookCall("onError", () => wiring.hooks.onError?.(cause))
    }
    throw cause
  } finally {
    run.toolsController.abort()
    try {
      await hookCall("onFinish", () =>
        wiring.hooks.onFinish?.(run.state.resultText, run.state.step, run.messages)
      )
    } catch (finishCause) {
      if (!failed) throw finishCause
      void failure
    }
  }
}

const launchPendingBackground = async (run: Run): Promise<void> => {
  const { wiring } = run
  const pendingBackground = pendingBackgroundCalls(run.messages, {
    displayTitle: wiring.toolset.displayTitle
  })
  if (pendingBackground.length === 0) return
  const entries = await wiring.toolset.entries()
  const claimed = await hookCall(
    "claimBackgroundCalls",
    async () =>
      new Map(
        (await wiring.hooks.claimBackgroundCalls?.(
          pendingBackground.map((call) => call.toolCall.id)
        )) ?? []
      )
  )
  for (const held of claimed.values()) {
    if (run.backgroundSignal.aborted) held.stop()
    else run.backgroundSignal.addEventListener("abort", held.stop, { once: true })
  }
  const unclaimed = pendingBackground.filter((call) => !claimed.has(call.toolCall.id))
  const recovered = await hookCall(
    "recoverToolCalls",
    async () =>
      new Map(
        [
          ...((unclaimed.length === 0
            ? undefined
            : await wiring.hooks.recoverToolCalls?.(unclaimed)) ?? [])
        ].map(([id, value]) => [id, normalizeToolResult(value)])
      )
  )
  await run.background.launch({
    calls: pendingBackground,
    metas: new Map(entries.map((entry) => [entry.meta.name, entry.meta])),
    mode: "message",
    recovered,
    claimed
  })
}

const resumeIncomplete = async (run: Run): Promise<boolean> => {
  const { wiring, state, messages } = run
  const incomplete = incompleteToolStep(messages, wiring.toolset.displayTitle)
  if (incomplete === null) return false
  const entries = await wiring.toolset.entries()
  const metas = new Map(entries.map((entry) => [entry.meta.name, entry.meta]))
  const metadata = wiring.toolset.metadata
  if (metadata !== undefined) {
    const hiddenNames = new Set(
      incomplete.pendingCalls.map((call) => call.name).filter((name) => !metas.has(name))
    )
    for (const name of hiddenNames) {
      const meta = await metadata(name)
      if (meta?.name === name) metas.set(name, meta)
    }
  }
  const deferredPendingNames = new Set(
    incomplete.pendingCalls
      .filter((call) => metas.get(call.name)?.deferred === true)
      .map((call) => call.name)
  )
  await loadDeferredCalls({
    calls: incomplete.pendingCalls,
    deferredNames: deferredPendingNames,
    load: (names) =>
      wiring.toolset.seedLoadedNames === undefined
        ? wiring.toolset.load(names)
        : wiring.toolset.seedLoadedNames(names)
  })
  const recovered = await hookCall("recoverToolCalls", async () => {
    const raw = new Map((await wiring.hooks.recoverToolCalls?.(incomplete.pendingCalls)) ?? [])
    const callsById = new Map(
      incomplete.pendingCalls.map((call) => [call.toolCall.id, call] as const)
    )
    return new Map(
      [...raw].map(([id, value]) => {
        const call = callsById.get(id)
        if (call === undefined) return [id, normalizeToolResult(value)]
        return [
          id,
          decorateToolResult(
            {
              name: call.name,
              args: structuredClone(call.args),
              toolCallId: id,
              signal: run.signal,
              messages
            },
            value,
            wiring.toolset
          )
        ]
      })
    )
  })
  const callsToExecute = incomplete.pendingCalls.filter((call) => !recovered.has(call.toolCall.id))
  const missingIds = new Set(incomplete.pendingCalls.map((call) => call.toolCall.id))
  const missingRaw = incomplete.rawToolCalls.filter((call) => missingIds.has(call.id))
  const rejection = turnEndingToolBatchRejection(incomplete.pendingCalls, metas)
  if (rejection === null) {
    const reserved = await run.budget.reserveToolCalls(
      callsToExecute.length,
      wiring.config.maxToolCalls
    )
    if (!reserved) {
      const denial = invoke("policy.budgetDenialContent", () =>
        budgetDenialResult(StopReason.MAX_TOOL_CALLS, wiring.config.policy)
      )
      const settled = new Map(recovered)
      for (const call of callsToExecute) settled.set(call.toolCall.id, denial)
      await runTools(run, [], missingRaw, metas, { recoveredResults: settled })
      state.step = 1
      await stepFinished(run)
      await finalize(run, state.resultText, StopReason.MAX_TOOL_CALLS, 1)
      return true
    }
  }
  const executed = await runTools(run, callsToExecute, missingRaw, metas, {
    recoveredResults: recovered,
    ...(rejection === null ? { foreground: true } : { rejection })
  })
  state.step = 1
  if (executed.paused.length > 0) {
    await finalizePaused(run, 1, executed.paused)
    return true
  }
  if (rejection === null) {
    const terminal =
      recoveredTerminalText(incomplete.pendingCalls, recovered, metas) ??
      terminalCompletionText(executed.completions)
    if (terminal !== undefined) {
      await stepFinished(run)
      await finalize(run, terminal, StopReason.END_TURN, 1)
      return true
    }
  }
  await stepFinished(run)
  return false
}

const finalizePaused = async (
  run: Run,
  steps: number,
  paused: ReadonlyArray<ToolPaused>
): Promise<void> => {
  const running = run.background.running()
  const hold = run.wiring.hooks.holdBackgroundCalls
  if (running.length > 0 && hold !== undefined) {
    try {
      await hookCall("holdBackgroundCalls", () => hold(running))
    } catch (error) {
      for (const call of running) call.stop()
      throw error
    }
  }
  run.detachBackground()
  await finalize(run, "", StopReason.PAUSED, steps, pauseResult(paused))
}

const remainingWallTime = (run: Run): { readonly maxWaitMs?: number } => {
  const { wiring, state } = run
  return wiring.config.maxWallTimeMs === undefined
    ? {}
    : {
        maxWaitMs: wiring.config.maxWallTimeMs - (invoke("clock", wiring.clock) - state.startedAtMs)
      }
}

const step = async (run: Run): Promise<StepOutcome> => {
  const { wiring, state, messages } = run
  const settled = await run.background.drain({ grace: true })
  if (settled.completions.length > 0)
    state.noProgressSteps = nextNoProgressCount(state.noProgressSteps, settled.completions)
  if (
    wiring.config.maxNoProgressSteps > 0 &&
    state.noProgressSteps >= wiring.config.maxNoProgressSteps
  ) {
    await finalize(run, state.resultText, StopReason.NO_PROGRESS, state.step)
    return "done"
  }
  if (settled.paused.length > 0) {
    await finalizePaused(run, state.step, settled.paused)
    return "done"
  }
  const drained = await drainPending(run)
  state.inputAdmission = { pending: false }
  const newest = messages.at(-1)
  if (
    drained === 0 &&
    state.modelTurnCount === 0 &&
    newest !== undefined &&
    isOwnerMessage(run, newest)
  )
    await announceInputTaken(run)

  if (wiring.config.maxIterations !== undefined && state.step >= wiring.config.maxIterations) {
    await finalize(run, state.resultText, StopReason.MAX_ITERATIONS, state.step)
    return "done"
  }
  const initialBudgetStop = await stopForBudget(run)
  if (initialBudgetStop !== null) {
    await finalize(run, state.resultText, initialBudgetStop, state.step)
    return "done"
  }

  const view = await prepare(run)
  const preparedBudgetStop = await stopForBudget(run)
  if (preparedBudgetStop !== null) {
    await finalize(run, state.resultText, preparedBudgetStop, state.step)
    return "done"
  }

  const turnStart = messages.length
  const turn = await callModel(run, view)
  const response = turn.response
  const message = response.message
  const rawCalls = message.tool_calls ?? []
  const undispatched = rawCalls.filter((call) => !state.streamedTools.ids.has(call.id))
  if (state.streamedTools.output.paused.length > 0) {
    await finalizePaused(run, state.step + 1, state.streamedTools.output.paused)
    return "done"
  }
  const afterModelBudgetStop = await stopForBudget(run)
  if (afterModelBudgetStop !== null) {
    if (rawCalls.length > 0) {
      invoke("policy.budgetDenialContent", () => {
        appendBudgetDenials(messages, undispatched, afterModelBudgetStop, wiring.config.policy)
      })
    }
    await finalize(run, state.resultText, afterModelBudgetStop, state.step)
    return "done"
  }

  if (response.finish_reason === "length") {
    if (rawCalls.length > 0) {
      invoke("policy.budgetDenialContent", () => {
        appendBudgetDenials(
          messages,
          undispatched,
          StopReason.MAX_OUTPUT_LENGTH,
          wiring.config.policy
        )
      })
    }
    await finalize(run, (message.content ?? "").trim(), StopReason.MAX_OUTPUT_LENGTH, state.step)
    return "done"
  }

  if (rawCalls.length === 0 && response.continuation === true && !run.background.pending) {
    state.step += 1
    return "continue"
  }
  return rawCalls.length === 0
    ? settleTextTurn(run, view, message, turnStart)
    : runToolTurn(run, view, message)
}

const settleTextTurn = async (
  run: Run,
  view: StepView,
  message: ProviderMessage,
  turnStart: number
): Promise<StepOutcome> => {
  const { wiring, state, messages } = run
  const providerCalls = message.provider_tool_calls ?? []
  const deferredNames = new Set(view.deferredTools.map((tool) => tool.name))
  const providerLoaded = await loadDeferredCalls({
    calls: [],
    deferredNames,
    providerCalls,
    load: (names) => wiring.toolset.load(names)
  })
  const silentMiss =
    providerCalls.length > 0 &&
    view.deferredTools.length > 0 &&
    (message.content ?? "").trim().length === 0
  if (providerLoaded.size > 0 || silentMiss) {
    state.step += 1
    await stepFinished(run)
    return "continue"
  }
  if (run.background.pending) {
    const arrival = new AbortController()
    const wake = wiring.hooks
      .waitForPendingMessages?.(arrival.signal)
      .catch(() => new Promise<void>(() => {}))
    let settled: DispatchOutput
    try {
      settled =
        (await drainPending(run)) > 0
          ? { completions: [], paused: [] }
          : await run.background.drain({
              wait: true,
              ...(wake === undefined ? {} : { wake }),
              ...remainingWallTime(run)
            })
    } finally {
      arrival.abort()
    }
    if (settled.paused.length > 0) {
      await finalizePaused(run, state.step, settled.paused)
      return "done"
    }
    if (settled.completions.length > 0)
      state.noProgressSteps = nextNoProgressCount(state.noProgressSteps, settled.completions)
    state.step += 1
    return "continue"
  }
  const pendingCount = await drainPending(run)
  if (pendingCount > 0) return "continue"
  const finalText = (message.content ?? "").trim()
  if (
    !state.finalTextChecked &&
    finalText.length > 0 &&
    wiring.hooks.checkFinalText !== undefined
  ) {
    state.finalTextChecked = true
    const correction = await hookCall("checkFinalText", () =>
      wiring.hooks.checkFinalText?.(finalText)
    )
    if (correction !== undefined) {
      const rejected = messages
        .slice(turnStart)
        .flatMap((record) =>
          record.role === "assistant" && typeof record.message_id === "string"
            ? [record.message_id]
            : []
        )
      const correctionId = messageId("text")
      messages.push({
        role: "user",
        message_id: correctionId,
        is_meta: true,
        content: correction,
        rejected_message_ids: rejected
      })
      await run.emit({
        _tag: "FinalTextSuperseded",
        depth: 0,
        parent_id: null,
        message_ids: rejected,
        correction_message_id: correctionId
      })
      state.step += 1
      await stepFinished(run)
      return "continue"
    }
  }
  if (run.output !== undefined) {
    const validated = await validateOutputText(run.output.schema, finalText)
    if ("issues" in validated) {
      if (!state.outputCorrectionUsed) {
        state.outputCorrectionUsed = true
        messages.push({
          role: "user",
          message_id: messageId("text"),
          is_meta: true,
          content: correctionContent(validated.issues)
        })
        state.step += 1
        await stepFinished(run)
        return "continue"
      }
      throw new StructuredOutputError(
        `structured output failed validation after one correction retry: ${
          formatIssues(validated.issues) || "the value does not match the schema"
        }`,
        validated.issues
      )
    }
    state.structuredObject = { value: validated.value }
  }
  await finalize(run, finalText, StopReason.END_TURN, state.step)
  return "done"
}

const runToolTurn = async (
  run: Run,
  view: StepView,
  message: ProviderMessage
): Promise<StepOutcome> => {
  const { wiring, state, messages } = run
  const rawCalls = message.tool_calls ?? []
  const { calls, deferredNames } = admitToolCalls({
    rawCalls,
    view,
    displayTitle: wiring.toolset.displayTitle
  })
  await loadDeferredCalls({
    calls,
    deferredNames,
    providerCalls: message.provider_tool_calls ?? [],
    load: (names) => wiring.toolset.load(names)
  })

  const refusal = turnEndingBatchRefusal(calls, rawCalls, view.metas)
  if (refusal !== null) {
    await runTools(run, refusal.refused, refusal.refusedRaw, view.metas, {
      rejection: refusal.rejection
    })
  }
  const others = calls.filter(
    (call) =>
      !(refusal?.refused ?? []).includes(call) && !state.streamedTools.ids.has(call.toolCall.id)
  )
  const othersRaw = rawCalls.filter(
    (call) => !state.streamedTools.ids.has(call.id) && !(refusal?.refusedRaw ?? []).includes(call)
  )
  if (refusal !== null && others.length === 0 && state.streamedTools.ids.size === 0) {
    state.noProgressSteps += 1
    state.step += 1
    if (
      wiring.config.maxNoProgressSteps > 0 &&
      state.noProgressSteps >= wiring.config.maxNoProgressSteps
    ) {
      await finalize(run, state.resultText, StopReason.NO_PROGRESS, state.step)
      return "done"
    }
    await stepFinished(run)
    return "continue"
  }

  const reserved = await run.budget.reserveToolCalls(others.length, wiring.config.maxToolCalls)
  if (!reserved) {
    invoke("policy.budgetDenialContent", () => {
      appendBudgetDenials(messages, othersRaw, StopReason.MAX_TOOL_CALLS, wiring.config.policy)
    })
    await finalize(run, state.resultText, StopReason.MAX_TOOL_CALLS, state.step)
    return "done"
  }

  const backgroundCalls = others.filter((call) =>
    isBackgroundCall(call, view.metas.get(call.name), view.asyncMode)
  )
  const backgroundOutput = await run.background.launch({
    calls: backgroundCalls,
    metas: view.metas,
    mode: view.asyncMode
  })
  const backgroundIds = new Set(backgroundCalls.map((call) => call.toolCall.id))
  const remaining = await runTools(
    run,
    others.filter((call) => !backgroundIds.has(call.toolCall.id)),
    othersRaw.filter((call) => !backgroundIds.has(call.id)),
    view.metas,
    { foreground: true }
  )
  const executed = {
    completions: [
      ...state.streamedTools.output.completions,
      ...backgroundOutput.completions,
      ...remaining.completions
    ],
    paused: [...state.streamedTools.output.paused, ...backgroundOutput.paused, ...remaining.paused]
  }
  if (executed.paused.length > 0) {
    state.step += 1
    await finalizePaused(run, state.step, executed.paused)
    return "done"
  }

  const terminal = terminalCompletionText(executed.completions)
  if (terminal !== undefined) {
    state.step += 1
    await stepFinished(run)
    await finalize(run, terminal, StopReason.END_TURN, state.step)
    return "done"
  }

  if (executed.completions.length > 0)
    state.noProgressSteps = nextNoProgressCount(state.noProgressSteps, executed.completions)
  if (
    wiring.config.maxNoProgressSteps > 0 &&
    state.noProgressSteps >= wiring.config.maxNoProgressSteps
  ) {
    state.step += 1
    await finalize(run, state.resultText, StopReason.NO_PROGRESS, state.step)
    return "done"
  }

  const afterToolsBudgetStop = await stopForBudget(run)
  if (afterToolsBudgetStop !== null) {
    const finalizeInstruction = wiring.config.policy.finalizeInstruction
    if (afterToolsBudgetStop === StopReason.MAX_TOKEN_BUDGET && finalizeInstruction !== undefined) {
      const { toolSearch: _, ...searchless } = view
      const finalizeView: StepView = {
        ...searchless,
        messages,
        tools: [],
        deferredTools: [],
        toolChoice: ToolChoice.NONE
      }
      const finalTurn = await callModel(run, finalizeView, finalizeInstruction)
      state.resultText = (finalTurn.response.message.content ?? "").trim()
    }
    await finalize(run, state.resultText, afterToolsBudgetStop, state.step)
    return "done"
  }

  state.step += 1
  await stepFinished(run)
  return "continue"
}
