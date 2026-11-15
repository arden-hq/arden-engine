/**
 * `@arden-hq/loop/provider-kit` — the transport pieces a model provider needs:
 * classified errors, the bounded retry policy, the SSE body reader, the
 * streamed-request loop, rejection classification, tool-history ordering and
 * abort helpers. A provider imports this kit and the root contracts, nothing else.
 */

export { isAbortError, raceAbort } from "../../abort.js"
export { contextBlockText } from "./content.js"
export {
  HttpStatusError,
  ProviderError,
  RetryableProviderError,
  SemanticResponseError
} from "./errors.js"
export { sameOrigin } from "./origin.js"
export {
  classifyRejection,
  httpRejection,
  isContextOverflow,
  MAX_STATUS_DETAIL_CHARS,
  ProviderStatusError,
  type Rejection,
  rejectionFields
} from "./rejection.js"
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
export {
  MISSING_TOOL_OUTPUT,
  orderToolHistory,
  type ToolHistoryBatch,
  type ToolHistoryWire
} from "./tool-history.js"
export {
  abortReason,
  checkTransportOptions,
  type ProviderAuth,
  providerAuthHeaders,
  type ProviderAuthHeadersOptions,
  type ProviderErrorClass,
  type SseEventMapper,
  type SseRequest,
  streamSse
} from "./transport.js"
