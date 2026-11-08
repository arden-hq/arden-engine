/**
 * `@arden-hq/loop/provider-kit` — the transport pieces a model provider needs:
 * classified errors, the bounded retry policy, the SSE body reader, and abort
 * helpers. A provider imports this kit and the root contracts, nothing else.
 */

export { isAbortError, raceAbort } from "../../abort.js"
export {
  HttpStatusError,
  ProviderError,
  RetryableProviderError,
  SemanticResponseError
} from "./errors.js"
export {
  backoffSleep,
  DEFAULT_MAX_ATTEMPTS,
  isRetryableFailure,
  nextRetry,
  retryDelayMs,
  retrying,
  retryingFetch
} from "./retry.js"
export { readSseEvents, type SseEvent, SseParser } from "./sse.js"
