import {
  MODEL_PROVIDER_PROTOCOL,
  STRUCTURED_OUTPUT_SUPPORT,
  ToolChoice
} from "../../contracts/provider.js"
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
import {
  COMPAT_STRUCTURED_OUTPUT,
  DEFAULT_COMPAT,
  ownedBodyKeys,
  type ChatCompletionsCompat
} from "./compat.js"
import { ChatCompletionsProviderError, statusFailureCode } from "./errors.js"
import { makePayload, type PayloadContext } from "./request.js"
import { makeChunkMapper } from "./stream.js"

export {
  CACHE_CONTROL_STYLE,
  COMPAT_STRUCTURED_OUTPUT,
  REASONING_EFFORT_STYLE,
  TOOL_CHOICE_NONE
} from "./compat.js"
export type {
  CacheControlStyle,
  ChatCompletionsCompat,
  CompatStructuredOutput,
  ReasoningEffortStyle,
  ToolChoiceNone
} from "./compat.js"
export { ChatCompletionsProviderError } from "./errors.js"
export type { ProviderAuth, ProviderAuthHeadersOptions } from "../kit/index.js"

export interface ChatCompletionsProviderOptions {
  readonly providerId: string
  readonly baseUrl: string
  readonly auth?: ProviderAuth
  readonly fetch?: typeof globalThis.fetch
  readonly idleTimeoutMs?: number
  readonly maxAttempts?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly extraBody?: JsonObject
  readonly generateId?: () => string
  readonly compat?: Partial<ChatCompletionsCompat>
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
    structuredOutput:
      compat.structuredOutput === COMPAT_STRUCTURED_OUTPUT.jsonSchema
        ? STRUCTURED_OUTPUT_SUPPORT.native
        : STRUCTURED_OUTPUT_SUPPORT.none,
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
          callsAllowed: request.toolChoice !== ToolChoice.NONE
        })
    })
  }
  return Object.freeze({
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    capabilities: options.capabilities ?? (() => capabilities),
    stream
  })
}
