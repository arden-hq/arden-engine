import { ROLE } from "@arden-hq/std/message-vocabulary"
import { isBackgroundCall } from "./streaming-tools.js"
import { harnessNotice } from "./harness-notice.js"
import { isAbortError } from "../abort.js"
import type { DispatchOutput } from "../tools/dispatch.js"
import { admitToolCalls, loadDeferredCalls } from "./tool-admission.js"
import { PROVIDER_ERROR_CODE, providerErrorCode, StructuredOutputError } from "../errors.js"
import { messageId, type ChatMessage } from "../contracts/messages.js"
import { FinishReason, ToolChoice, type ProviderMessage } from "../contracts/provider.js"
import { StopReason, type AgentEvent } from "../contracts/events.js"
import { hookCall, invoke } from "./guards.js"
import {
  appendBudgetDenials,
  appendOutputLimitContinuation,
  maxOutputLimitContinuations,
  nextNoProgressCount,
  terminalCompletionText,
  turnEndingBatchRefusal
} from "./policy.js"
import {
  callModel,
  makeRun,
  prepare,
  runTools,
  type AgentWiring,
  type Emit,
  type Run,
  type StepView
} from "./run-state.js"
import { stopForBudget } from "./run-cost.js"
import { finalize, finalizePaused } from "./run-result.js"
import { launchPendingBackground, resumeIncomplete } from "./run-resume.js"
import { announceInputTaken, drainPending, isOwnerMessage, stepFinished } from "./run-input.js"
import {
  correctionContent,
  formatIssues,
  validateOutputText,
  type AgentOutputOptions
} from "./structured-output.js"

const STEP_OUTCOME = { continue: "continue", done: "done" } as const
type StepOutcome = (typeof STEP_OUTCOME)[keyof typeof STEP_OUTCOME]

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
      if ((await step(run)) === STEP_OUTCOME.done) return
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
    return STEP_OUTCOME.done
  }
  if (settled.paused.length > 0) {
    await finalizePaused(run, state.step, settled.paused)
    return STEP_OUTCOME.done
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
    return STEP_OUTCOME.done
  }
  const initialBudgetStop = await stopForBudget(run)
  if (initialBudgetStop !== null) {
    await finalize(run, state.resultText, initialBudgetStop, state.step)
    return STEP_OUTCOME.done
  }

  const prepared = await prepare(run)
  const preparedBudgetStop = await stopForBudget(run)
  if (preparedBudgetStop !== null) {
    await finalize(run, state.resultText, preparedBudgetStop, state.step)
    return STEP_OUTCOME.done
  }

  const { view, turn, turnStart } = await callModelPastOverflow(run, prepared)
  const response = turn.response
  const message = response.message
  const rawCalls = message.tool_calls ?? []
  const undispatched = rawCalls.filter((call) => !state.streamedTools.ids.has(call.id))
  if (state.streamedTools.output.paused.length > 0) {
    await finalizePaused(run, state.step + 1, state.streamedTools.output.paused)
    return STEP_OUTCOME.done
  }
  const afterModelBudgetStop = await stopForBudget(run)
  if (afterModelBudgetStop !== null) {
    if (rawCalls.length > 0) {
      invoke("policy.budgetDenialContent", () => {
        appendBudgetDenials(messages, undispatched, afterModelBudgetStop, wiring.config.policy)
      })
    }
    await finalize(run, state.resultText, afterModelBudgetStop, state.step)
    return STEP_OUTCOME.done
  }

  if (response.finish_reason === FinishReason.LENGTH) {
    const structuredReplyCannotResume = run.output !== undefined
    if (
      !structuredReplyCannotResume &&
      state.outputLimitContinuations < maxOutputLimitContinuations
    ) {
      state.outputLimitContinuations += 1
      appendOutputLimitContinuation(messages, undispatched)
      state.step += 1
      await stepFinished(run)
      return STEP_OUTCOME.continue
    }
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
    return STEP_OUTCOME.done
  }
  state.outputLimitContinuations = 0

  if (rawCalls.length === 0 && response.continuation === true && !run.background.pending) {
    state.step += 1
    return STEP_OUTCOME.continue
  }
  return rawCalls.length === 0
    ? settleTextTurn(run, view, message, turnStart)
    : runToolTurn(run, view, message)
}

const callModelPastOverflow = async (run: Run, view: StepView) => {
  const turnStart = run.messages.length
  try {
    return { view, turn: await callModel(run, view), turnStart }
  } catch (cause) {
    if (
      providerErrorCode(cause) !== PROVIDER_ERROR_CODE.contextLengthExceeded ||
      run.signal.aborted ||
      run.messages.slice(turnStart).some((message) => message.role === ROLE.assistant)
    )
      throw cause
    const shortened = await prepare(run, { contextOverflow: true })
    if (!shortened.overflowAnswered) throw cause
    run.state.modelTurnCount -= 1
    return {
      view: shortened,
      turn: await callModel(run, shortened),
      turnStart: run.messages.length
    }
  }
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
    return STEP_OUTCOME.continue
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
      return STEP_OUTCOME.done
    }
    if (settled.completions.length > 0)
      state.noProgressSteps = nextNoProgressCount(state.noProgressSteps, settled.completions)
    state.step += 1
    return STEP_OUTCOME.continue
  }
  const pendingCount = await drainPending(run)
  if (pendingCount > 0) return STEP_OUTCOME.continue
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
          record.role === ROLE.assistant && typeof record.message_id === "string"
            ? [record.message_id]
            : []
        )
      const correctionId = messageId("text")
      messages.push({
        ...harnessNotice("final_text_check", correction, correctionId),
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
      return STEP_OUTCOME.continue
    }
  }
  if (run.output !== undefined) {
    const validated = await validateOutputText(run.output.schema, finalText)
    if ("issues" in validated) {
      if (!state.outputCorrectionUsed) {
        state.outputCorrectionUsed = true
        messages.push(harnessNotice("output_schema", correctionContent(validated.issues)))
        state.step += 1
        await stepFinished(run)
        return STEP_OUTCOME.continue
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
  return STEP_OUTCOME.done
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
      return STEP_OUTCOME.done
    }
    await stepFinished(run)
    return STEP_OUTCOME.continue
  }

  const reserved = await run.budget.reserveToolCalls(others.length, wiring.config.maxToolCalls)
  if (!reserved) {
    invoke("policy.budgetDenialContent", () => {
      appendBudgetDenials(messages, othersRaw, StopReason.MAX_TOOL_CALLS, wiring.config.policy)
    })
    await finalize(run, state.resultText, StopReason.MAX_TOOL_CALLS, state.step)
    return STEP_OUTCOME.done
  }

  const backgroundCalls = others.filter((call) =>
    isBackgroundCall(call, view.metas.get(call.name), view.asyncMode)
  )
  const backgroundOutput = await run.background.launch({
    calls: backgroundCalls,
    metas: view.metas
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
    return STEP_OUTCOME.done
  }

  const terminal = terminalCompletionText(executed.completions)
  if (terminal !== undefined) {
    state.step += 1
    await stepFinished(run)
    await finalize(run, terminal, StopReason.END_TURN, state.step)
    return STEP_OUTCOME.done
  }

  if (executed.completions.length > 0)
    state.noProgressSteps = nextNoProgressCount(state.noProgressSteps, executed.completions)
  if (
    wiring.config.maxNoProgressSteps > 0 &&
    state.noProgressSteps >= wiring.config.maxNoProgressSteps
  ) {
    state.step += 1
    await finalize(run, state.resultText, StopReason.NO_PROGRESS, state.step)
    return STEP_OUTCOME.done
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
    return STEP_OUTCOME.done
  }

  state.step += 1
  await stepFinished(run)
  return STEP_OUTCOME.continue
}
