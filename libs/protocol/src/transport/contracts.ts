import type { ServerEvent } from "../events/contracts.js"

export interface SseFrame {
  readonly id?: string
  readonly event: string
  readonly data: string
}

/** Reconnection policy carried by an SSE `retry:` directive. */
export interface SseRetryDirective {
  readonly retryAfterMs: number
  readonly lastEventId?: string
}

export interface DecodedServerEventFrame<E extends ServerEvent = ServerEvent> {
  readonly id?: string
  readonly event: E["type"]
  readonly data: E
}

/** A frame whose `type` this build of the protocol does not know. */
export interface UnknownServerEventFrame {
  readonly id?: string
  readonly event: string
  readonly type: string
}

export interface SseDecodeOptions {
  readonly maxEventSize?: number
  readonly onRetry?: (directive: SseRetryDirective) => void
  /**
   * Called once per dropped frame. A newer server may send an event type an
   * older client has never seen; the decoders skip it and continue, so a
   * rollout never breaks the stream. A known type with a bad payload still
   * fails the stream.
   */
  readonly onUnknownEvent?: (frame: UnknownServerEventFrame) => void
}

export interface EncodeServerEventOptions {
  readonly id?: string
}
