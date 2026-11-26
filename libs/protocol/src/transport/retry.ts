import { Duration, Effect } from "effect"
import type { Retry } from "effect/unstable/encoding/Sse"

import type { SseDecodeOptions, SseRetryDirective } from "./contracts.js"

export const parserOptions = (options?: SseDecodeOptions): { maxEventSize: number } | undefined =>
  options?.maxEventSize === undefined ? undefined : { maxEventSize: options.maxEventSize }

const toDirective = (retry: Retry): SseRetryDirective =>
  retry.lastEventId === undefined
    ? { retryAfterMs: Duration.toMillis(retry.duration) }
    : {
        retryAfterMs: Duration.toMillis(retry.duration),
        lastEventId: retry.lastEventId
      }

export const notifyRetry = (
  options: SseDecodeOptions | undefined,
  retry: Retry
): Effect.Effect<void | undefined, never, never> =>
  Effect.sync(() => options?.onRetry?.(toDirective(retry)))
