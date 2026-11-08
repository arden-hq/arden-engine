import { WebSocket } from "ws"
import { retryAfterHints } from "@arden-hq/std/retry"
import { HttpStatusError, RetryableProviderError } from "@arden-hq/loop/provider-kit"
import {
  statusFailureCode,
  type ConnectResponsesWebSocket
} from "@arden-hq/loop/providers/openai-responses"

export const connectResponsesWebSocket = async ({
  url,
  headers,
  signal,
  observeHeaders,
  observeEvent
}: Parameters<ConnectResponsesWebSocket>[0] & {
  readonly observeHeaders?: (headers: Headers) => void
  readonly observeEvent?: (event: unknown) => void
}): ReturnType<ConnectResponsesWebSocket> => {
  const socket = new WebSocket(url, {
    headers: { ...headers },
    maxPayload: 16 * 1024 * 1024
  })
  socket.on("upgrade", (response) => {
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
    }
    observeHeaders?.(headers)
  })
  const queue: unknown[] = []
  let waiting: (() => void) | undefined
  let failure: Error | undefined
  let closed = false
  const wake = () => {
    waiting?.()
    waiting = undefined
  }
  const abort = () => socket.terminate()
  signal.addEventListener("abort", abort, { once: true })
  socket.on("message", (data) => {
    try {
      const parsed: unknown = JSON.parse(data.toString())
      observeEvent?.(parsed)
      queue.push(parsed)
    } catch (cause) {
      failure = new Error("OpenAI returned invalid WebSocket JSON", { cause })
      socket.terminate()
    }
    wake()
  })
  socket.on("unexpected-response", (_request, response) => {
    const status = response.statusCode ?? 502
    const { retryAfter, retryAfterMs } = retryAfterHints(response.headers)
    failure = new HttpStatusError(`OpenAI WebSocket handshake failed with status ${status}`, {
      status,
      retryAfter,
      retryAfterMs,
      code: statusFailureCode(status, null)
    })
    socket.terminate()
    wake()
  })
  socket.on("error", (cause) => {
    failure ??= cause
    wake()
  })
  socket.on("close", () => {
    closed = true
    signal.removeEventListener("abort", abort)
    wake()
  })
  if (signal.aborted) socket.terminate()
  const deadline = setTimeout(() => {
    failure = new RetryableProviderError("OpenAI WebSocket connection timed out")
    socket.terminate()
    wake()
  }, 10_000)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", (cause) =>
        reject(
          signal.aborted ? new DOMException("Operation aborted", "AbortError") : (failure ?? cause)
        )
      )
      socket.once("close", () =>
        reject(
          signal.aborted
            ? new DOMException("Operation aborted", "AbortError")
            : (failure ?? new RetryableProviderError("OpenAI WebSocket closed during connection"))
        )
      )
    })
  } finally {
    clearTimeout(deadline)
  }
  return {
    isClosed: () => socket.readyState !== WebSocket.OPEN || failure !== undefined,
    close: () => {
      signal.removeEventListener("abort", abort)
      socket.close()
    },
    send: (event) => socket.send(JSON.stringify(event)),
    events: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (failure !== undefined) throw failure
          if (queue.length > 0) {
            yield queue.shift()
            continue
          }
          if (closed) return
          await new Promise<void>((resolve) => {
            waiting = resolve
          })
        }
      }
    }
  }
}
