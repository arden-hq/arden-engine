import { createParser, type EventSourceParser } from "eventsource-parser"
import { hasAbortName, isAbortError, raceAbort } from "../../abort.js"
import { RetryableProviderError } from "./errors.js"
import { errorMessage } from "@arden-hq/std/errors"
import { after } from "@arden-hq/std/timer"

export interface SseEvent {
  readonly event: string
  readonly data: string
}

export const SSE_DONE = "[DONE]"

export class SseParser {
  #events: Array<SseEvent> = []
  #parser: EventSourceParser
  retryDelayMs: number | undefined

  constructor() {
    this.#parser = createParser({
      onEvent: (message) => {
        this.#events.push({ event: message.event ?? "message", data: message.data })
      },
      onRetry: (delayMs) => {
        this.retryDelayMs = delayMs
      }
    })
  }

  feed(chunk: string): Array<SseEvent> {
    this.#parser.feed(chunk)
    const events = this.#events
    this.#events = []
    return events
  }
}

const asTransportError = (cause: unknown, streamName: string): unknown =>
  isAbortError(cause) || (cause instanceof DOMException && hasAbortName(cause))
    ? cause
    : new RetryableProviderError(errorMessage(cause, `${streamName} failed`))

const raceIdle = <A>(promise: Promise<A>, idleTimeoutMs: number, streamName: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = after(idleTimeoutMs, () =>
      reject(new RetryableProviderError(`${streamName} became idle`))
    )
    promise.then(
      (value) => {
        timer.cancel()
        resolve(value)
      },
      (cause) => {
        timer.cancel()
        reject(cause)
      }
    )
  })

const observeRejectionOfReadAbandonedByAbort = (): void => {}

export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  parser: SseParser,
  options: {
    readonly idleTimeoutMs: number
    readonly streamName: string
    readonly signal?: AbortSignal
  }
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const read = raceIdle(
        reader.read().catch((cause: unknown) => {
          throw asTransportError(cause, options.streamName)
        }),
        options.idleTimeoutMs,
        options.streamName
      )
      read.catch(observeRejectionOfReadAbandonedByAbort)
      const next = await raceAbort(read, options.signal)
      if (next.done) break
      yield* parser.feed(decoder.decode(next.value, { stream: true }))
    }
    yield* parser.feed(decoder.decode())
  } finally {
    void reader.cancel().catch(() => {})
  }
}
