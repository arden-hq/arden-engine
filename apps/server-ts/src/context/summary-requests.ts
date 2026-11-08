import type { ModelProvider, ModelProviderRequest } from "@arden-hq/loop"

import type { StoredMessageEnvelope } from "../persistence/transcript/model.js"

export interface SummaryRequest {
  readonly sessionId: string
  readonly provider: ModelProvider
  readonly request: ModelProviderRequest
}

export interface PrefixInput {
  readonly sessionId: string
  readonly provider: ModelProvider
  readonly model: string
  readonly reasoningEffort: string | null
  readonly source: ReadonlyArray<StoredMessageEnvelope>
  readonly history: ReadonlyArray<StoredMessageEnvelope>
}

export const replayPrefix = (
  saved: SummaryRequest | undefined,
  input: PrefixInput
): ModelProviderRequest | undefined => {
  if (
    saved === undefined ||
    saved.provider !== input.provider ||
    saved.request.model !== input.model ||
    (saved.request.reasoningEffort ?? null) !== input.reasoningEffort ||
    saved.request.responseFormat !== undefined
  )
    return undefined

  const historyIds = new Set(input.history.map((message) => message.message_id))
  const replay = saved.request.messages.filter(
    (message) =>
      message.role !== "system" ||
      (message.message_id !== undefined && historyIds.has(message.message_id))
  )
  if (
    input.source.length === 0 ||
    replay.length < input.source.length ||
    replay.length > input.history.length ||
    replay.some((message, index) => message.message_id !== input.history[index]?.message_id) ||
    input.source.some((message, index) => message.message_id !== replay[index]?.message_id)
  )
    return undefined
  return saved.request
}

export class SummaryRequests {
  private readonly requests = new Map<string, SummaryRequest>()

  remember({ sessionId, provider, request }: SummaryRequest): SummaryRequest {
    const { signal: _signal, steering: _steering, ...replay } = request
    this.requests.delete(sessionId)
    const saved = { sessionId, provider, request: { ...replay, messages: [...request.messages] } }
    this.requests.set(sessionId, saved)
    if (this.requests.size > 8) {
      const oldest = this.requests.keys().next()
      if (!oldest.done) this.requests.delete(oldest.value)
    }
    return saved
  }

  prefix(input: PrefixInput): ModelProviderRequest | undefined {
    return replayPrefix(this.requests.get(input.sessionId), input)
  }

  forget(sessionId: string): void {
    this.requests.delete(sessionId)
  }
}
