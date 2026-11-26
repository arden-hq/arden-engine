import { ROLE } from "@arden-hq/std/message-vocabulary"

import { renderInteraction } from "../src/agent/interactions.js"
import type { ModelProviderRequest } from "../src/contracts/provider.js"

const encoder = new TextEncoder()

export interface StreamControl {
  readonly send: (data: unknown) => void
  readonly end: () => void
  readonly destroy: () => void
}

export const sseResponse = (
  script: (control: StreamControl) => void,
  onClose?: () => void
): Response => {
  let open = true
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      script({
        send: (data) => {
          if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        },
        end: () => {
          if (!open) return
          open = false
          controller.close()
        },
        destroy: () => {
          if (!open) return
          open = false
          controller.error(new TypeError("terminated"))
        }
      })
    },
    cancel() {
      onClose?.()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })
}

export interface RecordedRequest {
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly at: number
}

export const makeTransport = (
  handlers: ReadonlyArray<(signal: AbortSignal | undefined) => Response>
): { readonly fetchImpl: typeof globalThis.fetch; readonly requests: Array<RecordedRequest> } => {
  const requests: Array<RecordedRequest> = []
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    const handler = handlers[requests.length]
    requests.push({
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      at: Date.now()
    })
    if (handler === undefined) throw new Error("unexpected connection attempt")
    return handler(init?.signal ?? undefined)
  }
  return { fetchImpl, requests }
}

export const baseRequest: ModelProviderRequest = {
  model: "gpt-5.4",
  messages: [{ role: ROLE.user, content: "Hi." }],
  renderInteraction,
  tools: [],
  deferredTools: [],
  toolChoice: "auto"
}

export const staticAuth = {
  headers: async () => ({ authorization: "Bearer token-1" })
}

interface WeatherToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

export const toolCall = (id: string): WeatherToolCall => ({
  id,
  type: "function" as const,
  function: { name: "weather", arguments: "{}" }
})

export const simpleCompleted = {
  id: "resp-simple",
  output: [
    {
      id: "msg-1",
      type: "message",
      role: ROLE.assistant,
      content: [{ type: "output_text", text: "Recovered." }],
      status: "completed"
    }
  ],
  usage: {
    input_tokens: 3,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2
  }
} as const
