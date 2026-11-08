/**
 * Idleness and network failures surface as RetryableProviderError so the
 * kit's retry policy classifies them; abort errors pass through.
 */
import { createParser, type EventSourceParser } from "eventsource-parser"
import { isAbortError, raceAbort } from "../../abort.js"
import { RetryableProviderError } from "./errors.js"
import { errorMessage } from "@arden-hq/std/errors"

export interface SseEvent {
  readonly event: string
  readonly data: string
}

/** Incremental SSE decoder with the same seam the provider consumed before. */
export class SseParser {
  #events: Array<SseEvent> = []
  #parser: EventSourceParser
  /** Last `retry:` reconnection hint seen on the wire, in milliseconds. */
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
  isAbortError(cause) || (cause instanceof DOMException && cause.name === "AbortError")
    ? cause
    : new RetryableProviderError(errorMessage(cause, `${streamName} failed`))

const raceIdle = <A>(promise: Promise<A>, idleTimeoutMs: number, streamName: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RetryableProviderError(`${streamName} became idle`)),
      idleTimeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timer)
        reject(cause)
      }
    )
  })

/**
 * Reads `body` as SSE events. `streamName` opens the failure messages
 * ("<streamName> became idle", "<streamName> failed").
 */
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
      // The abort race can win and abandon the read; observe its late rejection.
      read.catch(() => {})
      const next = await raceAbort(read, options.signal)
      if (next.done) break
      yield* parser.feed(decoder.decode(next.value, { stream: true }))
    }
    yield* parser.feed(decoder.decode())
  } finally {
    void reader.cancel().catch(() => {})
  }
}
