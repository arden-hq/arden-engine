import { retryAfterHints } from "@arden-hq/std/retry"
import { openResponsesSession, type ConnectResponsesWebSocket } from "./websocket.js"
export type { ConnectResponsesWebSocket, ResponsesWebSocket } from "./websocket.js"
/**
 * OpenAI Responses streaming provider over plain fetch. The host owns
 * credentials: the factory only receives an `auth.headers()` broker (called
 * once per connection attempt, with `forceRefresh` on the single pre-emission
 * 401 retry), so tokens never enter the lib. Transport failures retry under
 * the provider kit's bounded policy (D-123); event mapping and response-item
 * history semantics are ported byte-for-byte from the previous Effect-based
 * server provider.
 */
import type {
  ModelCapabilities,
  ModelProvider,
  ModelProviderRequest,
  ModelStreamItem
} from "../../contracts/provider.js"
import {
  backoffSleep,
  DEFAULT_MAX_ATTEMPTS,
  nextRetry,
  ProviderError,
  raceAbort,
  readSseEvents,
  RetryableProviderError,
  SemanticResponseError,
  type SseEvent,
  SseParser
} from "../kit/index.js"
import { OpenAiResponsesProviderError, StatusError } from "./errors.js"
import { asRecord, type RawResponseEvent } from "./items.js"
import { makePayload } from "./request.js"
import { makeEventMapper } from "./response.js"
import { errorMessage } from "@arden-hq/std/errors"

export { OpenAiResponsesProviderError, statusFailureCode } from "./errors.js"
export { makePayload, type ResponsesPayload } from "./request.js"

export interface OpenAiResponsesAuthHeadersOptions {
  readonly signal: AbortSignal
  readonly forceRefresh?: boolean
}

/** Host-owned credential broker: returns the full auth header set per attempt. */
export interface OpenAiResponsesAuth {
  readonly headers: (options: OpenAiResponsesAuthHeadersOptions) => Promise<Record<string, string>>
}

export interface OpenAiResponsesProviderOptions {
  readonly connectWebSocket?: ConnectResponsesWebSocket
  /** Adapter-local route policy, independent of async tools and steering. Defaults to SSE. */
  readonly transport?: (model: string) => "sse" | "websocket"
  /**
   * The host's capability table for its routes. Without one, every model gets
   * hosted web search, native structured output, portable async tools, and
   * boundary steering; native async and steering are opt-in per verified route.
   */
  readonly capabilities?: ModelProvider["capabilities"]
  readonly auth: OpenAiResponsesAuth
  readonly fetch?: typeof globalThis.fetch
  readonly baseUrl?: string
  /** Maximum silence between SSE reads before the idle transport retry. */
  readonly idleTimeoutMs?: number
  /** Total connection attempts per request, including the first (default 5). */
  readonly maxAttempts?: number
  /** Optional host-owned catalog prefix that the upstream API does not accept. */
  readonly modelPrefix?: string
  /** Instructions used only when the request history has no system message. */
  readonly defaultInstructions?: string
  /** Omit the Responses API token-limit field for endpoints that reject it. */
  readonly omitMaxOutputTokens?: boolean
  /**
   * Request header that also carries the request's `cacheScope`, for routes
   * that pick the cache by header rather than by `prompt_cache_key`. The
   * ChatGPT Codex backend reads `session-id`.
   */
  readonly cacheScopeHeader?: string
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_CAPABILITIES: ModelCapabilities = Object.freeze({
  hostedTools: Object.freeze(["web_search"]),
  structuredOutput: "native",
  asyncTools: "message",
  steering: "boundary"
})
const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const MAX_ERROR_DETAIL_BYTES = 16_384
const MAX_ERROR_DETAIL_WAIT_MS = 5_000

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The model request was cancelled", "AbortError")

const waitBeforeRetry = async (delayMs: number, signal: AbortSignal | undefined): Promise<void> => {
  try {
    await backoffSleep(delayMs, signal)
  } catch {
    if (signal?.aborted) throw abortReason(signal)
    throw new OpenAiResponsesProviderError("OpenAI response retry was interrupted")
  }
}

const sanitizedFailure = (error: unknown): OpenAiResponsesProviderError => {
  if (error instanceof OpenAiResponsesProviderError) return error
  if (error instanceof ProviderError)
    return new OpenAiResponsesProviderError(error.message, error.code)
  return new OpenAiResponsesProviderError("OpenAI response stream failed")
}

const rawEvent = (event: SseEvent): RawResponseEvent => {
  if (event.data.trim() === "[DONE]") return { type: "response.done" }
  if (event.data.trim().length === 0) return { type: event.event }
  let decoded: unknown
  try {
    decoded = JSON.parse(event.data)
  } catch {
    throw new SemanticResponseError("OpenAI returned an invalid SSE event")
  }
  const record = asRecord(decoded)
  if (record === null) throw new SemanticResponseError("OpenAI returned an invalid SSE event")
  return typeof record.type === "string" ? record : { ...record, type: event.event }
}

interface ResolvedOptions {
  readonly auth: OpenAiResponsesAuth
  readonly fetch: typeof globalThis.fetch
  readonly baseUrl: string
  readonly idleTimeoutMs: number
  readonly maxAttempts: number
  readonly cacheScopeHeader: string | undefined
}

const authHeaders = async (
  options: ResolvedOptions,
  signal: AbortSignal | undefined,
  forceRefresh: boolean
): Promise<Record<string, string>> => {
  try {
    signal?.throwIfAborted()
    const headers = await options.auth.headers({
      signal: signal ?? new AbortController().signal,
      ...(forceRefresh ? { forceRefresh: true } : {})
    })
    signal?.throwIfAborted()
    return headers
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    if (error instanceof OpenAiResponsesProviderError) throw error
    throw new OpenAiResponsesProviderError(
      "The account could not provide credentials",
      "provider_auth"
    )
  }
}

const readErrorDetail = async (
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  idleTimeoutMs: number
): Promise<string | null> => {
  if (body === null) return null
  const reader = body.getReader()
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), Math.min(idleTimeoutMs, MAX_ERROR_DETAIL_WAIT_MS))
  const readSignal = AbortSignal.any([signal, timeout.signal])
  const decoder = new TextDecoder()
  let detail = ""
  let bytes = 0
  try {
    while (bytes < MAX_ERROR_DETAIL_BYTES) {
      const chunk = await raceAbort(reader.read(), readSignal)
      if (chunk.done) return detail + decoder.decode()
      const available = MAX_ERROR_DETAIL_BYTES - bytes
      const slice = chunk.value.subarray(0, available)
      detail += decoder.decode(slice, { stream: true })
      bytes += slice.byteLength
    }
    return detail + decoder.decode()
  } catch {
    if (signal.aborted) throw abortReason(signal)
    return detail || null
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

const connect = async (
  options: ResolvedOptions,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  let response: Response
  try {
    response = await options.fetch(`${options.baseUrl}/responses`, {
      method: "POST",
      headers: {
        ...headers,
        accept: "text/event-stream",
        "content-type": "application/json"
      },
      body,
      signal
    })
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new RetryableProviderError(errorMessage(cause, "OpenAI request failed"))
  }
  if (!response.ok) {
    const { retryAfter, retryAfterMs } = retryAfterHints(response.headers)
    const detail = await readErrorDetail(response.body, signal, options.idleTimeoutMs)
    throw new StatusError(response.status, retryAfter, retryAfterMs, detail)
  }
  if (response.body === null)
    throw new RetryableProviderError("OpenAI returned an empty response body")
  return response.body
}

const streamResponse = async function* (
  request: ModelProviderRequest,
  options: ResolvedOptions,
  payloadJson: string
): AsyncGenerator<ModelStreamItem> {
  let forceRefresh = false
  let authRetried = false
  let attempts = 0

  while (true) {
    attempts += 1
    let emitted = false
    const headers = {
      ...(await authHeaders(options, request.signal, forceRefresh)),
      ...(options.cacheScopeHeader === undefined || request.cacheScope === undefined
        ? {}
        : { [options.cacheScopeHeader]: request.cacheScope })
    }
    request.signal?.throwIfAborted()
    forceRefresh = false
    const attempt = new AbortController()
    const signal = request.signal
    const propagateAbort = (): void => {
      if (signal !== undefined) attempt.abort(abortReason(signal))
    }
    signal?.addEventListener("abort", propagateAbort, { once: true })
    const parser = new SseParser()
    const mapEvent = makeEventMapper(request.model, request.toolSearch)
    try {
      const body = await connect(options, headers, payloadJson, attempt.signal)
      let terminal = false
      for await (const event of readSseEvents(body, parser, {
        idleTimeoutMs: options.idleTimeoutMs,
        streamName: "OpenAI response stream",
        ...(request.signal === undefined ? {} : { signal: request.signal })
      })) {
        if (request.signal?.aborted) throw abortReason(request.signal)
        for (const item of mapEvent(rawEvent(event))) {
          emitted = true
          yield item
          if (item._tag === "Completed") {
            terminal = true
            break
          }
        }
        if (terminal) return
      }
      throw new RetryableProviderError("OpenAI response stream ended before a terminal event")
    } catch (error) {
      if (request.signal?.aborted) throw abortReason(request.signal)
      attempt.abort()
      if (!emitted && !authRetried && error instanceof StatusError && error.status === 401) {
        authRetried = true
        forceRefresh = true
        attempts -= 1
        continue
      }
      const delayMs = nextRetry(attempts, error, {
        maxAttempts: options.maxAttempts,
        wireHintMs: parser.retryDelayMs
      })
      if (delayMs !== undefined) {
        yield {
          _tag: "ProviderStreamRetry",
          attempt: attempts,
          maxAttempts: options.maxAttempts,
          delayMs,
          reason: errorMessage(error, "Stream failed")
        }
        await waitBeforeRetry(delayMs, request.signal)
        continue
      }
      throw sanitizedFailure(error)
    } finally {
      request.signal?.removeEventListener("abort", propagateAbort)
      attempt.abort()
    }
  }
}

export const makeOpenAiResponsesProvider = (
  options: OpenAiResponsesProviderOptions
): ModelProvider => {
  if (
    options.idleTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs <= 0)
  ) {
    throw new OpenAiResponsesProviderError("OpenAI idle timeout must be a positive integer")
  }
  if (
    options.maxAttempts !== undefined &&
    (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0)
  ) {
    throw new OpenAiResponsesProviderError("OpenAI max attempts must be a positive integer")
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const resolved: ResolvedOptions = Object.freeze({
    auth: options.auth,
    fetch: options.fetch ?? globalThis.fetch,
    baseUrl: baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    cacheScopeHeader: options.cacheScopeHeader
  })
  const modelPrefix = options.modelPrefix ?? ""
  const defaultInstructions = options.defaultInstructions
  const connectWebSocket = options.connectWebSocket
  const capabilities: NonNullable<ModelProvider["capabilities"]> =
    options.capabilities ?? (() => DEFAULT_CAPABILITIES)
  const stream = (request: ModelProviderRequest) => {
    const payloadRequest =
      options.omitMaxOutputTokens === true
        ? (({ maxOutputTokens: _, ...rest }) => rest)(request)
        : request
    const payload = makePayload(payloadRequest, modelPrefix, defaultInstructions)
    return streamResponse(request, resolved, JSON.stringify(payload))
  }
  return Object.freeze({
    protocolVersion: 1,
    capabilities,
    stream,
    ...(connectWebSocket === undefined
      ? {}
      : {
          openSession: () =>
            openResponsesSession({
              connect: connectWebSocket,
              headers: (signal, forceRefresh) => authHeaders(resolved, signal, forceRefresh),
              baseUrl: resolved.baseUrl,
              modelPrefix,
              ...(defaultInstructions === undefined ? {} : { defaultInstructions }),
              ...(options.omitMaxOutputTokens === undefined
                ? {}
                : { omitMaxOutputTokens: options.omitMaxOutputTokens }),
              maxAttempts: resolved.maxAttempts,
              idleTimeoutMs: resolved.idleTimeoutMs,
              capabilities,
              transport: options.transport ?? (() => "sse"),
              ...(options.cacheScopeHeader === undefined
                ? {}
                : { cacheScopeHeader: options.cacheScopeHeader }),
              fallback: stream
            })
        })
  })
}
