import { connectResponsesWebSocket } from "./websocket.js"
import type { ModelProvider } from "@arden-hq/loop"
import { Option, Schema } from "effect"
import {
  makeOpenAiResponsesProvider as makeLibOpenAiResponsesProvider,
  OpenAiResponsesProviderError,
  type OpenAiResponsesProviderOptions as LibResponsesOptions
} from "@arden-hq/loop/providers/openai-responses"

export { OpenAiResponsesProviderError }

export interface OpenAiCredentialSnapshot {
  readonly accessToken: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface OpenAiCredentialSource {
  readonly get: (options: {
    readonly signal: AbortSignal
    readonly forceRefresh?: boolean
  }) => Promise<OpenAiCredentialSnapshot>
}

export interface OpenAiResponsesProviderOptions {
  readonly transport?: NonNullable<LibResponsesOptions["transport"]>
  readonly observeWebSocketHeaders?: (headers: Headers) => void
  readonly observeWebSocketEvent?: (event: unknown) => void
  readonly capabilities?: ModelProvider["capabilities"]
  readonly baseUrl: string
  readonly credentials: OpenAiCredentialSource
  readonly headers?: Readonly<Record<string, string>>
  /** Maximum silence between SSE events before the one transport retry. */
  readonly idleTimeoutMs?: number
  /** Optional host-owned catalog prefix that the upstream API does not accept. */
  readonly modelPrefix?: string
  /** Instructions used only when the request history has no system message. */
  readonly defaultInstructions?: string
  /** Omit the Responses API token-limit field for endpoints that reject it. */
  readonly omitMaxOutputTokens?: boolean
  /** Request header that also carries the prompt cache key (Codex: `session-id`). */
  readonly cacheScopeHeader?: string
  /** Transport for model requests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch
}

const CredentialsSchema = Schema.Struct({
  accessToken: Schema.String.check(Schema.makeFilter((token) => token.trim().length > 0)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const decodeCredentials = (value: unknown): typeof CredentialsSchema.Type => {
  const decoded = Schema.decodeUnknownOption(CredentialsSchema)(value)
  if (Option.isNone(decoded)) {
    throw new OpenAiResponsesProviderError(
      "The account returned invalid credentials",
      "provider_auth"
    )
  }
  return decoded.value
}

export const makeOpenAiResponsesProvider = ({
  credentials,
  headers,
  observeWebSocketHeaders,
  observeWebSocketEvent,
  ...options
}: OpenAiResponsesProviderOptions): ModelProvider =>
  makeLibOpenAiResponsesProvider({
    ...options,
    connectWebSocket: (connection) =>
      connectResponsesWebSocket({
        ...connection,
        ...(observeWebSocketHeaders === undefined
          ? {}
          : { observeHeaders: observeWebSocketHeaders }),
        ...(observeWebSocketEvent === undefined ? {} : { observeEvent: observeWebSocketEvent })
      }),
    auth: {
      headers: async ({ signal, forceRefresh }) => {
        const snapshot = decodeCredentials(
          await credentials.get({
            signal,
            ...(forceRefresh === true ? { forceRefresh: true } : {})
          })
        )
        return {
          ...headers,
          ...snapshot.headers,
          authorization: `Bearer ${snapshot.accessToken}`
        }
      }
    }
  })
