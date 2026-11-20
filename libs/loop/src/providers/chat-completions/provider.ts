import { MODEL_PROVIDER_PROTOCOL } from "../../contracts/provider.js"
/**
 * OpenAI-compatible Chat Completions streaming provider: llama.cpp
 * `llama-server`, OpenRouter, and any server that speaks
 * `POST {baseUrl}/chat/completions` with SSE. Wire differences between
 * servers are the `compat` flags, never a branch on who serves the route.
 * The connection loop, retry and error-body read are the provider kit's
 * `streamSse`; stored history is ordered by the kit's `orderToolHistory`.
 */
import type { JsonObject } from "../../contracts/messages.js"
import type {
  ModelCapabilities,
  ModelProvider,
  ModelProviderRequest
} from "../../contracts/provider.js"
import {
  checkTransportOptions,
  DEFAULT_MAX_ATTEMPTS,
  type ProviderAuth,
  streamSse
} from "../kit/index.js"
import { DEFAULT_COMPAT, ownedBodyKeys, type ChatCompletionsCompat } from "./compat.js"
import { ChatCompletionsProviderError, statusFailureCode } from "./errors.js"
import { makePayload, type PayloadContext } from "./request.js"
import { makeChunkMapper } from "./stream.js"

export type { ChatCompletionsCompat } from "./compat.js"
export { ChatCompletionsProviderError } from "./errors.js"
export type { ProviderAuth, ProviderAuthHeadersOptions } from "../kit/index.js"

export interface ChatCompletionsProviderOptions {
  /**
   * Who serves this route (`"llama.cpp"`, `"openrouter"`): the `provider` of
   * every answer's origin, which decides whether stored replay state goes
   * back, and the name failures start with.
   */
  readonly providerId: string
  /** Requests go to `${baseUrl}/chat/completions`. */
  readonly baseUrl: string
  /** Host-owned credential broker; absent for a server without a key (local llama.cpp). */
  readonly auth?: ProviderAuth
  readonly fetch?: typeof globalThis.fetch
  /** Maximum silence between SSE reads before the idle transport retry. */
  readonly idleTimeoutMs?: number
  /** Total connection attempts per request, including the first (default 5). */
  readonly maxAttempts?: number
  /** Static headers sent with every request (OpenRouter's `HTTP-Referer`, `X-Title`). */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Extra top-level body fields (OpenRouter's `provider` routing). A field
   * the adapter writes itself is refused when the provider is made.
   */
  readonly extraBody?: JsonObject
  /** Id for a streamed tool call that arrives without one. */
  readonly generateId?: () => string
  /** Wire differences from the defaults in `ChatCompletionsCompat`. */
  readonly compat?: Partial<ChatCompletionsCompat>
  /**
   * The host's capability table for its routes (image input limits, for
   * one). Without one, every model gets the capabilities `compat` implies.
   */
  readonly capabilities?: ModelProvider["capabilities"]
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000

const defaultGenerateId = (): string => `call_${globalThis.crypto.randomUUID()}`

export const makeChatCompletionsProvider = (
  options: ChatCompletionsProviderOptions
): ModelProvider => {
  const label = options.providerId
  if (label.trim().length === 0)
    throw new ChatCompletionsProviderError("A Chat Completions provider needs a provider id")
  checkTransportOptions({
    label,
    idleTimeoutMs: options.idleTimeoutMs,
    maxAttempts: options.maxAttempts,
    errorClass: ChatCompletionsProviderError
  })
  const compat: ChatCompletionsCompat = Object.freeze({ ...DEFAULT_COMPAT, ...options.compat })
  const extraBody = options.extraBody ?? {}
  const owned = ownedBodyKeys(compat).filter((key) => key in extraBody)
  if (owned.length > 0)
    throw new ChatCompletionsProviderError(
      `${label} extraBody may not set ${owned.join(", ")}: the adapter writes them`
    )
  const baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl
  const context: PayloadContext = Object.freeze({
    providerId: options.providerId,
    label,
    compat,
    extraBody
  })
  const capabilities: ModelCapabilities = Object.freeze({
    hostedTools: Object.freeze([]),
    structuredOutput: compat.structuredOutput === "json_schema" ? "native" : "none",
    asyncTools: "message",
    steering: "boundary",
    toolSearch: "client",
    ...(compat.imageInput ? { imageInput: { limits: undefined } } : {})
  })
  const fetch = options.fetch ?? globalThis.fetch
  const generateId = options.generateId ?? defaultGenerateId
  const stream = (request: ModelProviderRequest) => {
    const body = JSON.stringify(makePayload(request, context))
    return streamSse({
      url: `${baseUrl}/chat/completions`,
      body,
      fetch,
      auth: options.auth,
      headers: options.headers ?? {},
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      signal: request.signal,
      label,
      errorClass: ChatCompletionsProviderError,
      classifyStatus: statusFailureCode,
      mapper: () =>
        makeChunkMapper({
          requestedModel: request.model,
          providerId: options.providerId,
          label,
          generateId,
          toolSearch: request.toolSearch,
          callsAllowed: request.toolChoice !== "none"
        })
    })
  }
  return Object.freeze({
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    capabilities: options.capabilities ?? (() => capabilities),
    stream
  })
}
