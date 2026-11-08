import type { CompletionResponse } from "@arden-hq/loop"
import { Effect, Redacted, Schema } from "effect"

import { type DecisionInputKind, DecisionsError } from "./questions.js"

type DecisionWireFormat = "decisions" | "systemone" | "openrouter-decisions" | "llama-systemone"

type DecisionEndpointAuth =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly apiKey: Redacted.Redacted<string> }
  | {
      readonly kind: "header"
      readonly name: string
      readonly value: Redacted.Redacted<string>
    }

export interface DecisionEndpoint {
  readonly id: string
  readonly format: DecisionWireFormat
  readonly baseUrl: string
  readonly auth: DecisionEndpointAuth
  readonly model: string
  readonly input: DecisionInputKind
  readonly timeoutMs: number
  readonly fetch: typeof globalThis.fetch
  readonly onUsage?: (usage: CompletionResponse["usage"]) => void
}

export const postDecisionRequest = Effect.fn("Decisions.post")(function* (
  endpoint: DecisionEndpoint,
  request: {
    readonly body: unknown
    readonly signal: AbortSignal | undefined
    readonly headers?: Readonly<Record<string, string>>
  }
) {
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort())
  )
  const url = new URL(endpoint.baseUrl)
  const path = url.pathname.replace(/\/+$/, "")
  const route =
    endpoint.format === "openrouter-decisions"
      ? "/alpha/decisions"
      : `/v1/${endpoint.format === "llama-systemone" ? "systemone" : endpoint.format}`
  url.pathname = path.endsWith(route)
    ? path
    : `${path.endsWith("/v1") ? path.slice(0, -3) : path}${route}`
  const timeout = AbortSignal.timeout(endpoint.timeoutMs)
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      endpoint.fetch(url.toString(), {
        method: "POST",
        headers: {
          ...request.headers,
          ...authHeader(endpoint.auth),
          "content-type": "application/json"
        },
        body: JSON.stringify(request.body),
        signal: AbortSignal.any([
          controller.signal,
          signal,
          timeout,
          ...(request.signal === undefined ? [] : [request.signal])
        ])
      }),
    catch: (cause) =>
      new DecisionsError({ reason: "provider", message: "The decision request failed", cause })
  })
  if (response.status === 401 || response.status === 403) {
    return yield* new DecisionsError({
      reason: "unavailable",
      message: `The decision endpoint refused the credential (${response.status})`,
      status: response.status
    })
  }
  if (!response.ok) {
    return yield* new DecisionsError({
      reason: response.status === 400 || response.status === 422 ? "invalid_request" : "provider",
      message: `The decision endpoint rejected the request (${response.status}); check the model, format and image limits`,
      status: response.status
    })
  }
  const body = yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: (cause) =>
      new DecisionsError({
        reason: "invalid_output",
        message: "The decision endpoint answered with no JSON",
        cause
      })
  })
  const decoded = Schema.decodeUnknownOption(DecisionUsageSchema)(body)
  if (decoded._tag === "Some") {
    endpoint.onUsage?.({
      prompt_tokens: decoded.value.usage.input_tokens,
      completion_tokens: decoded.value.usage.output_tokens
    })
  }
  return body
}, Effect.scoped)

const DecisionUsageSchema = Schema.Struct({
  usage: Schema.Struct({
    input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  })
})

const authHeader = (auth: DecisionEndpointAuth): Record<string, string> => {
  switch (auth.kind) {
    case "none":
      return {}
    case "bearer":
      return { authorization: `Bearer ${Redacted.value(auth.apiKey)}` }
    case "header":
      return { [auth.name]: Redacted.value(auth.value) }
  }
}
