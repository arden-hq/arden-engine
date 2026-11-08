import { usageInputTokens, type CompletionResponse } from "@arden-hq/loop"
import type { SummaryRequest } from "./summary-requests.js"
import { currentMillis } from "../runtime/clock.js"

export interface IdleCompactionRequest extends SummaryRequest {
  readonly response: CompletionResponse
  readonly startedAt: number
}

export interface IdleCompactionCandidate extends IdleCompactionRequest {
  readonly dueAt: number
  readonly inputTokens: number
}

export interface IdleCompactionDecision {
  readonly sessionId: string
  readonly decision: "queued" | "skipped" | "ran" | "failed"
  readonly reason: string
}

const MIN_INPUT_TOKENS = 64_000
const LATE_MS = 60_000

export class IdleCompactionQueue {
  private readonly pending = new Map<string, IdleCompactionCandidate>()
  private active: { readonly sessionId: string; readonly controller: AbortController } | undefined

  constructor(
    private readonly options: {
      readonly delayMs: number
      readonly report?: (decision: IdleCompactionDecision) => void
    }
  ) {}

  private static rejection(input: IdleCompactionRequest, inputTokens: number): string | undefined {
    if (input.response.finish_reason !== "stop") return "request did not end on stop"
    if (
      (input.response.message.tool_calls?.length ?? 0) > 0 ||
      (input.response.message.provider_tool_calls?.length ?? 0) > 0
    )
      return "request ended on tool calls"
    if (input.response.continuation === true) return "request is a continuation"
    if (input.request.model !== "openai-codex/gpt-6.1-sol") return "model is not idle-capable"
    if (input.request.responseFormat !== undefined) return "structured output request"
    if (input.request.cacheScope === undefined) return "request has no cache scope"
    if ((input.response.usage.cache_read_tokens ?? 0) === 0) return "no cache read"
    if (inputTokens < MIN_INPUT_TOKENS) return "under 64k input tokens"
    return undefined
  }

  private decide(sessionId: string, decision: IdleCompactionDecision["decision"], reason: string) {
    this.options.report?.({ sessionId, decision, reason })
  }

  remember(input: IdleCompactionRequest): void {
    this.cancel(input.sessionId, "chat ran again")
    if (this.options.delayMs <= 0) return
    const inputTokens = usageInputTokens(input.response.usage)
    const rejection = IdleCompactionQueue.rejection(input, inputTokens)
    if (rejection !== undefined) {
      if (inputTokens >= MIN_INPUT_TOKENS) this.decide(input.sessionId, "skipped", rejection)
      return
    }
    this.pending.set(input.sessionId, {
      ...input,
      inputTokens,
      dueAt: currentMillis() + this.options.delayMs
    })
    this.decide(
      input.sessionId,
      "queued",
      `due in ${Math.round(this.options.delayMs / 1000)} seconds`
    )
    if (this.pending.size > 8) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) {
        this.pending.delete(oldest)
        this.decide(oldest, "skipped", "queue full, oldest dropped")
      }
    }
  }

  take(now: number): IdleCompactionCandidate | undefined {
    for (const [id, candidate] of this.pending) {
      if (now < candidate.startedAt) {
        this.pending.delete(id)
        this.decide(id, "skipped", "clock moved back")
      }
      if (now < candidate.dueAt) continue
      this.pending.delete(id)
      if (now - candidate.dueAt <= LATE_MS) return candidate
      this.decide(id, "skipped", "missed its time by over a minute")
    }
    return undefined
  }

  cancel(sessionId: string, reason: string): void {
    if (this.pending.delete(sessionId)) this.decide(sessionId, "skipped", reason)
    this.interrupt(sessionId)
  }

  interrupt(sessionId: string): void {
    if (this.active?.sessionId === sessionId) this.active.controller.abort()
  }

  start(candidate: IdleCompactionCandidate): AbortController {
    if (this.active !== undefined) throw new Error("Idle compaction is already running")
    const controller = new AbortController()
    this.active = { sessionId: candidate.sessionId, controller }
    return controller
  }

  finish(controller: AbortController): void {
    if (this.active?.controller === controller) this.active = undefined
  }

  clear(reason: string): void {
    for (const id of this.pending.keys()) this.decide(id, "skipped", reason)
    this.pending.clear()
    this.active?.controller.abort()
  }
}
