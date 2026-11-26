import { MODEL_PROVIDER_PROTOCOL } from "../../contracts/provider.js"
import {
  openResponsesSession,
  type ConnectResponsesWebSocket,
  type ResponsesTransport
} from "./websocket.js"
export type { ConnectResponsesWebSocket, ResponsesWebSocket } from "./websocket.js"
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
  SSE_DONE,
  type SseEvent,
  type SseEventMapper,
  streamSse
} from "../kit/index.js"
import { OpenAiResponsesProviderError, statusFailureCode } from "./errors.js"
import { asRecord, RESPONSE_EVENT_TYPE, type RawResponseEvent } from "./items.js"
import { makePayload, responsesRoute } from "./request.js"
import { makeEventMapper } from "./response.js"
import { parseJsonText } from "@arden-hq/std/json-text"

export { OpenAiResponsesProviderError, statusFailureCode } from "./errors.js"
export { makePayload, type ResponsesPayload } from "./request.js"

export type OpenAiResponsesAuthHeadersOptions = ProviderAuthHeadersOptions

export type OpenAiResponsesAuth = ProviderAuth

export interface OpenAiResponsesProviderOptions {
  readonly connectWebSocket?: ConnectResponsesWebSocket
  readonly transport?: (model: string) => ResponsesTransport
  readonly capabilities?: ModelProvider["capabilities"]
  readonly auth: OpenAiResponsesAuth
  readonly fetch?: typeof globalThis.fetch
  readonly baseUrl?: string
  readonly providerId?: string
  readonly idleTimeoutMs?: number
  readonly maxAttempts?: number
  readonly modelPrefix?: string
  readonly defaultInstructions?: string
  readonly omitMaxOutputTokens?: boolean
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
  if (event.data.trim() === SSE_DONE) return { type: RESPONSE_EVENT_TYPE.done }
  if (event.data.trim().length === 0) return { type: event.event }
  let decoded: unknown
  try {
    decoded = parseJsonText(event.data)
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
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
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
