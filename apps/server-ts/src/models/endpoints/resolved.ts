import { MODEL_ENDPOINT_AUTH } from "@arden-hq/protocol/model-endpoints"
import { Redacted } from "effect"

import type { StoredEndpoint } from "../../persistence/model-endpoints/store.js"
import type { DecisionEndpoint } from "../decisions/endpoint.js"

export interface ResolvedEndpoint extends Omit<StoredEndpoint, "dimensions" | "health"> {
  readonly secret: string
}

export const headersOf = (auth: StoredEndpoint["auth"], secret: string): Record<string, string> =>
  auth.kind === MODEL_ENDPOINT_AUTH.bearer
    ? { authorization: `Bearer ${secret}` }
    : { [auth.name]: secret }

export const decisionEndpointOf = (
  endpoint: ResolvedEndpoint,
  fetch: typeof globalThis.fetch,
  timeoutMs: number
): DecisionEndpoint => ({
  id: "endpoint",
  format: {
    "openai-decisions": "decisions",
    "openrouter-decisions": "openrouter-decisions",
    systemone: "systemone",
    "openai-embeddings": "systemone"
  }[endpoint.format] as DecisionEndpoint["format"],
  baseUrl: endpoint.baseUrl,
  auth:
    endpoint.auth.kind === MODEL_ENDPOINT_AUTH.bearer
      ? { kind: "bearer", apiKey: Redacted.make(endpoint.secret) }
      : { kind: "header", name: endpoint.auth.name, value: Redacted.make(endpoint.secret) },
  model: endpoint.model,
  input: endpoint.input,
  timeoutMs,
  fetch
})
