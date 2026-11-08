import { Clock, Effect, Exit } from "effect"
import { ModelProviderService } from "../models/provider.js"
import { quotaDecision, quotaLimits, currentPlanReading } from "../models/plan-limits.js"
import { meteredModelCall } from "../models/call-usage.js"
import { ModelStore } from "../persistence/models/store.js"
import {
  ContextCompactionStore,
  type ContextCompactionSnapshot
} from "../persistence/compaction/store.js"
import { IntelligenceSettingsStore, LimitSettingsStore } from "../persistence/settings/store.js"
import { UsageStore } from "../persistence/usage/store.js"
import { planCompaction, type CompactionPlan } from "./planner.js"
import { HANDOFF_BYTES_PER_TOKEN, handoffContent } from "./handoff.js"
import { summarizeContext } from "./summarizer.js"
import { replayPrefix } from "./summary-requests.js"
import type { IdleCompactionCandidate, IdleCompactionDecision } from "./idle-queue.js"

export const makeIdleCompactor = Effect.fn("ContextCompaction.makeIdleCompactor")(
  function* (input: {
    readonly report: (decision: IdleCompactionDecision, cause?: unknown) => void
    readonly commit: (
      snapshot: ContextCompactionSnapshot,
      plan: CompactionPlan,
      summary: string
    ) => Effect.Effect<unknown, unknown>
  }) {
    const provider = yield* ModelProviderService
    const models = yield* ModelStore
    const store = yield* ContextCompactionStore
    const intelligence = yield* IntelligenceSettingsStore
    const limits = yield* LimitSettingsStore
    const usage = yield* UsageStore
    const compact = Effect.fn("ContextCompaction.idle")(function* (
      candidate: IdleCompactionCandidate,
      signal: AbortSignal
    ) {
      const skip = (reason: string) =>
        input.report({ sessionId: candidate.sessionId, decision: "skipped", reason })
      const route = provider.current()
      if (route?.provider !== candidate.provider) return skip("model route changed")
      if (route.planLimits === undefined) return skip("provider has no plan meter")
      const now = yield* Clock.currentTimeMillis
      if (now < candidate.dueAt || now - candidate.dueAt > 60_000) return skip("not at its time")
      const planLimits = route.planLimits
      const reading = yield* Effect.promise(() => currentPlanReading(planLimits, now))
      const checkedAt = yield* Clock.currentTimeMillis
      if (reading === undefined) return skip("no plan reading")
      if (checkedAt < reading.observedAt || checkedAt - reading.observedAt > 60_000)
        return skip("plan reading older than a minute")
      if (!reading.windows.some((window) => window.resetsAt > checkedAt))
        return skip("plan reading has no open window")
      const settings = yield* limits.settings()
      const quota = quotaDecision({
        reading,
        limits: quotaLimits(settings),
        quotaClass: "background",
        itemLimitPercent: undefined,
        now: checkedAt
      })
      if (quota.kind !== "admit") return skip(`quota paused: ${quota.reason}`)
      const snapshot = yield* store.snapshot({ sessionId: candidate.sessionId, purpose: "idle" })
      const selection = yield* models.selection(candidate.sessionId)
      if (selection.modelId === null) return skip("chat has no model")
      const modelId = selection.modelId
      const controls = yield* intelligence.settings()
      const plan = planCompaction(snapshot.messages, controls.compactionKeepRatio)
      if (plan === null) return skip("nothing to compact")
      const cachedRequest = replayPrefix(candidate, {
        sessionId: candidate.sessionId,
        provider: route.provider,
        model: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
        source: plan.source,
        history: snapshot.messages
      })
      if (cachedRequest === undefined) return skip("request no longer a prefix of the chat")
      const replayCount = cachedRequest.messages.filter(
        (message) =>
          message.role !== "system" ||
          snapshot.messages.some((stored) => stored.message_id === message.message_id)
      ).length
      const terminal = snapshot.messages.at(-1)
      if (
        snapshot.messages.length !== replayCount + 1 ||
        terminal?.role !== "assistant" ||
        terminal.content !== candidate.response.message.content
      )
        return skip("chat changed after the request")
      const budget = yield* models.contextBudget({
        modelId: selection.modelId,
        inputTokens: candidate.inputTokens,
        messageCount: snapshot.messages.length
      })
      if (
        candidate.inputTokens +
          candidate.response.usage.completion_tokens +
          controls.summaryMaxTokens +
          2_000 >=
        budget.hard_limit
      )
        return skip("summary would not fit the context window")
      const before = Buffer.byteLength(JSON.stringify(snapshot.messages))
      const tailBytes = Buffer.byteLength(JSON.stringify(plan.tail))
      const retained = tailBytes + Buffer.byteLength(handoffContent({ ...snapshot, summary: "" }))
      if (tailBytes + controls.summaryMaxTokens * HANDOFF_BYTES_PER_TOKEN > before / 2)
        return skip("kept tail too large to save half")
      if (signal.aborted) return skip("aborted before the summary")
      const submittedAt = yield* Clock.currentTimeMillis
      if (
        provider.current() !== route ||
        submittedAt < candidate.dueAt ||
        submittedAt - candidate.dueAt > 60_000
      )
        return skip("route or time changed before the summary")
      const summary = yield* meteredModelCall(
        usage,
        {
          kind: "compaction",
          owner: { type: "session", sessionId: candidate.sessionId },
          modelId: selection.modelId
        },
        (onResponse) =>
          Effect.callback<string, unknown>((resume, fiberSignal) => {
            const pending = summarizeContext({
              provider: route.provider,
              model: modelId,
              reasoningEffort: selection.reasoningEffort,
              sessionRef: snapshot.sessionRef,
              sourceSessionRef: snapshot.sourceSessionRef,
              sourceText: plan.sourceText,
              contextWindow: budget.hard_limit,
              maxOutputTokens: controls.summaryMaxTokens,
              cachedRequest: {
                ...cachedRequest,
                messages: [
                  ...cachedRequest.messages,
                  {
                    role: "assistant",
                    content: candidate.response.message.content ?? "",
                    tool_calls: candidate.response.message.tool_calls ?? [],
                    output_parts: candidate.response.message.output_parts ?? [],
                    ...(candidate.response.message.reasoning_content === null
                      ? {}
                      : {
                          reasoning_content: candidate.response.message.reasoning_content
                        }),
                    ...(candidate.response.message.provider_state === undefined
                      ? {}
                      : {
                          provider_state: candidate.response.message.provider_state
                        })
                  }
                ]
              },
              fallback: "none",
              signal: AbortSignal.any([signal, fiberSignal]),
              onResponse
            })
            pending.then(
              (value) => resume(Effect.succeed(value)),
              (cause: unknown) => resume(Effect.fail(cause))
            )
            return Effect.promise(() =>
              pending.then(
                () => undefined,
                () => undefined
              )
            )
          })
      )
      if (signal.aborted) return skip("aborted during the summary")
      if (provider.current() !== route) return skip("model route changed during the summary")
      if (retained + Buffer.byteLength(summary) > before / 2)
        return skip("summary saved less than half")
      yield* input.commit(snapshot, plan, summary)
      input.report({
        sessionId: candidate.sessionId,
        decision: "ran",
        reason: `${before} bytes to ${retained + Buffer.byteLength(summary)}`
      })
    })
    return (candidate: IdleCompactionCandidate, signal: AbortSignal) =>
      compact(candidate, signal).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.sync(() =>
                input.report(
                  {
                    sessionId: candidate.sessionId,
                    decision: "failed",
                    reason: signal.aborted ? "stopped by activity" : "error or timeout"
                  },
                  exit.cause
                )
              )
            : Effect.void
        )
      )
  }
)
