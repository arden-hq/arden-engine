import { Duration, Effect } from "effect"
import type { Retry } from "effect/unstable/encoding/Sse"

import { sseFrameId, type SseDecodeOptions, type SseRetryDirective } from "./contracts.js"

export const parserOptions = (options: SseDecodeOptions): { maxEventSize: number } => ({
  maxEventSize: options.maxEventSize
})

const toDirective = (retry: Retry): SseRetryDirective => ({
  retryAfterMs: Duration.toMillis(retry.duration),
  lastEventId: sseFrameId(retry.lastEventId)
})

export const notifyRetry = (
  options: SseDecodeOptions,
  retry: Retry
): Effect.Effect<void, never, never> => Effect.sync(() => options.onRetry(toDirective(retry)))
