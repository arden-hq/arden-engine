import type { CompletionResponse, ModelProvider, ModelProviderRequest } from "@arden-hq/loop"
import { currentMillis } from "../runtime/clock.js"

export interface CompletedModelRequest {
  readonly sessionId: string
  readonly request: ModelProviderRequest
  readonly response: CompletionResponse
  readonly startedAt: number
}

export const observeModelRequests =
  (sessionId: string, onComplete: ((input: CompletedModelRequest) => void) | undefined) =>
  (stream: ModelProvider["stream"]): ModelProvider["stream"] =>
    async function* (request) {
      const startedAt = currentMillis()
      const snapshot = { ...request, messages: [...request.messages] }
      for await (const item of await stream(request)) {
        if (item._tag === "Completed")
          onComplete?.({
            sessionId,
            request: snapshot,
            response: item,
            startedAt
          })
        yield item
      }
    }
