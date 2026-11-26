import { decorateToolResult } from "../tools/dispatch.js"
import { StopReason } from "../contracts/events.js"
import { normalizeToolResult } from "../internal/validate.js"
import { pendingBackgroundCalls } from "./background-tools.js"
import { hookCall, invoke } from "./guards.js"
import {
  budgetDenialResult,
  recoveredTerminalText,
  terminalCompletionText,
  turnEndingToolBatchRejection
} from "./policy.js"
import { incompleteToolStep } from "./recovery.js"
import { finalize, finalizePaused } from "./run-result.js"
import { stepFinished } from "./run-input.js"
import { runTools, type Run } from "./run-state.js"
import { loadDeferredCalls } from "./tool-admission.js"

export const launchPendingBackground = async (run: Run): Promise<void> => {
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
    recovered,
    claimed
  })
}

export const resumeIncomplete = async (run: Run): Promise<boolean> => {
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
