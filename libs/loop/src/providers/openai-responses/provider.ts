import { openResponsesSession, type ConnectResponsesWebSocket } from "./websocket.js"
export type { ConnectResponsesWebSocket, ResponsesWebSocket } from "./websocket.js"
/**
 * OpenAI Responses streaming provider over plain fetch. The host owns
 * credentials: the factory only receives an `auth.headers()` broker (called
 * once per connection attempt, with `forceRefresh` on the single pre-emission
 * 401 retry), so tokens never enter the lib. The connection loop, the
 * transport retry (D-123) and the error-body read are the provider kit's
 * `streamSse`; event mapping and response-item history semantics are ported
 * byte-for-byte from the previous Effect-based server provider.
 */
import type {
  ModelCapabilities,
  ModelProvider,
  ModelProviderRequest,
  ModelStreamItem
} from "../../contracts/provider.js"
import {
  checkTransportOptions,
  DEFAULT_MAX_ATTEMPTS,
  type ProviderAuth,
  type ProviderAuthHeadersOptions,
  providerAuthHeaders,
  SemanticResponseError,
  type SseEvent,
  type SseEventMapper,
  streamSse
} from "../kit/index.js"
import { OpenAiResponsesProviderError, statusFailureCode } from "./errors.js"
import { asRecord, type RawResponseEvent } from "./items.js"
import { makePayload, responsesRoute } from "./request.js"
import { makeEventMapper } from "./response.js"

export { OpenAiResponsesProviderError, statusFailureCode } from "./errors.js"
export { makePayload, type ResponsesPayload } from "./request.js"

export type OpenAiResponsesAuthHeadersOptions = ProviderAuthHeadersOptions

/** Host-owned credential broker: returns the full auth header set per attempt. */
export type OpenAiResponsesAuth = ProviderAuth

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
  /** Who serves this wire, stamped as the `provider` of every answer's origin (default `"openai"`). */
  readonly providerId?: string
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
const DEFAULT_PROVIDER_ID = "openai"
const LABEL = "OpenAI"
const DEFAULT_CAPABILITIES: ModelCapabilities = Object.freeze({
  hostedTools: Object.freeze(["web_search"]),
  structuredOutput: "native",
  asyncTools: "message",
  steering: "boundary"
})
const DEFAULT_IDLE_TIMEOUT_MS = 120_000

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
  readonly providerId: string
  readonly idleTimeoutMs: number
  readonly maxAttempts: number
  readonly cacheScopeHeader: string | undefined
}

const streamResponse = (
  request: ModelProviderRequest,
  options: ResolvedOptions,
  payloadJson: string
): AsyncGenerator<ModelStreamItem> =>
  streamSse({
    url: `${options.baseUrl}/responses`,
    body: payloadJson,
    fetch: options.fetch,
    auth: options.auth,
    headers:
      options.cacheScopeHeader === undefined || request.cacheScope === undefined
        ? {}
        : { [options.cacheScopeHeader]: request.cacheScope },
    idleTimeoutMs: options.idleTimeoutMs,
    maxAttempts: options.maxAttempts,
    signal: request.signal,
    label: LABEL,
    errorClass: OpenAiResponsesProviderError,
    classifyStatus: (status, detail) => statusFailureCode(status, detail ?? null),
    mapper: (): SseEventMapper => {
      const map = makeEventMapper({
        requestedModel: request.model,
        toolSearch: request.toolSearch,
        providerId: options.providerId
      })
      return { event: (event) => map(rawEvent(event)), end: () => [] }
    }
  })

export const makeOpenAiResponsesProvider = (
  options: OpenAiResponsesProviderOptions
): ModelProvider => {
  checkTransportOptions({
    label: LABEL,
    idleTimeoutMs: options.idleTimeoutMs,
    maxAttempts: options.maxAttempts,
    errorClass: OpenAiResponsesProviderError
  })
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const resolved: ResolvedOptions = Object.freeze({
    auth: options.auth,
    fetch: options.fetch ?? globalThis.fetch,
    baseUrl: baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl,
    providerId: options.providerId ?? DEFAULT_PROVIDER_ID,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    cacheScopeHeader: options.cacheScopeHeader
  })
  const modelPrefix = options.modelPrefix ?? ""
  const defaultInstructions = options.defaultInstructions
  const connectWebSocket = options.connectWebSocket
  const declared: NonNullable<ModelProvider["capabilities"]> =
    options.capabilities ?? (() => DEFAULT_CAPABILITIES)
  // Whether the limit is sent is this provider's own option, so it is
  // reported from that option rather than declared a second time.
  const capabilities: NonNullable<ModelProvider["capabilities"]> =
    options.omitMaxOutputTokens === true
      ? async (model) => ({ ...(await declared(model)), outputLimit: "omitted" })
      : declared
  const stream = async (request: ModelProviderRequest) => {
    const payloadRequest =
      options.omitMaxOutputTokens === true
        ? (({ maxOutputTokens: _, ...rest }) => rest)(request)
        : request
    const route = responsesRoute(await capabilities(request.model))
    const payload = makePayload(payloadRequest, modelPrefix, defaultInstructions, route)
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
              headers: (signal, forceRefresh) =>
                providerAuthHeaders({
                  auth: resolved.auth,
                  signal,
                  forceRefresh,
                  errorClass: OpenAiResponsesProviderError
                }),
              baseUrl: resolved.baseUrl,
              providerId: resolved.providerId,
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
