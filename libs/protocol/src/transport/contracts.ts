import type { ServerEvent } from "../events/contracts.js"

export const SSE_FRAME_ID = { anonymous: "anonymous", identified: "identified" } as const

export type SseFrameId =
  | { readonly kind: typeof SSE_FRAME_ID.anonymous }
  | { readonly kind: typeof SSE_FRAME_ID.identified; readonly id: string }

export const ANONYMOUS_FRAME: SseFrameId = { kind: SSE_FRAME_ID.anonymous }

export const sseFrameId = (id: string | undefined): SseFrameId =>
  id === undefined ? ANONYMOUS_FRAME : { kind: SSE_FRAME_ID.identified, id }

export interface SseFrame {
  readonly id: SseFrameId
  readonly event: string
  readonly data: string
}

/** Reconnection policy carried by an SSE `retry:` directive. */
export interface SseRetryDirective {
  readonly retryAfterMs: number
  readonly lastEventId: SseFrameId
}

export interface DecodedServerEventFrame<E extends ServerEvent = ServerEvent> {
  readonly id: SseFrameId
  readonly event: E["type"]
  readonly data: E
}

/** A frame whose `type` this build of the protocol does not know. */
export interface UnknownServerEventFrame {
  readonly id: SseFrameId
  readonly event: string
  readonly type: string
}

export interface SseDecodeOptions {
  readonly maxEventSize: number
  readonly onRetry: (directive: SseRetryDirective) => void
  /**
   * Called once per dropped frame. A newer server may send an event type an
   * older client has never seen; the decoders skip it and continue, so a
   * rollout never breaks the stream. A known type with a bad payload still
   * fails the stream.
   */
  readonly onUnknownEvent: (frame: UnknownServerEventFrame) => void
}

export const SSE_DECODE_DEFAULTS: SseDecodeOptions = {
  maxEventSize: 10 * 1024 * 1024,
  onRetry: () => undefined,
  onUnknownEvent: () => undefined
}

export interface EncodeServerEventOptions {
  readonly id: SseFrameId
}
