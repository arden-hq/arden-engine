import { Effect, Predicate } from "effect"

import type { DecisionManifest } from "./catalog.js"
import { LlamaServer, type LlamaServerError } from "./llama-server.js"
import type { DecisionEndpoint } from "../models/decisions/endpoint.js"

const LOCAL_DECISION_TIMEOUT_MS = 30_000

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const routerRequest = (
  text: string,
  modelId: string
):
  | { readonly kind: "ok"; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: "refused"; readonly message: string } => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { kind: "refused", message: "The body is not JSON" }
  }
  if (!Predicate.isObject(body) || Array.isArray(body)) {
    return { kind: "refused", message: "Expected { model, state, questions }" }
  }
  return { kind: "ok", body: { ...body, model: modelId } }
}

const statePrefixPrompt = (
  statePrompt: DecisionManifest["readout"]["statePrompt"],
  body: Readonly<Record<string, unknown>>
): string | undefined => {
  const { state, images } = body
  if (state === undefined || state === null) return undefined
  if (Array.isArray(images) && images.length > 0) return undefined
  const text = typeof state === "string" ? state : JSON.stringify(state, null, 2)
  return `${statePrompt.before}${text}${statePrompt.after}`
}

const localDecisionEndpoint = (
  llama: LlamaServer["Service"],
  manifest: DecisionManifest
): DecisionEndpoint => {
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/v1/systemone" || init?.method !== "POST") {
      return json(404, { error: "Only POST /v1/systemone is served here" })
    }
    const request = routerRequest(typeof init.body === "string" ? init.body : "", manifest.id)
    if (request.kind === "refused") return json(400, { error: request.message })
    const signal = init.signal ?? undefined
    const prefix = statePrefixPrompt(manifest.readout.statePrompt, request.body)
    const readPrefix =
      prefix === undefined
        ? Effect.void
        : Effect.ignore(
            llama.request("/completion", {
              body: { model: manifest.id, prompt: prefix, n_predict: 0, cache_prompt: true },
              signal
            })
          )
    return Effect.runPromise(
      readPrefix.pipe(
        Effect.andThen(llama.request("/v1/systemone", { body: request.body, signal })),
        Effect.map((response) => json(response.status, response.body)),
        Effect.catchTag("LlamaServerError", (error: LlamaServerError) =>
          Effect.succeed(json(error.reason === "request" ? 502 : 503, { error: error.message }))
        )
      ),
      signal === undefined ? undefined : { signal }
    )
  }

  return {
    id: manifest.id,
    format: "llama-systemone",
    baseUrl: `http://${manifest.id}.local-models.invalid`,
    auth: { kind: "none" },
    model: manifest.id,
    input: manifest.input,
    timeoutMs: LOCAL_DECISION_TIMEOUT_MS,
    fetch
  }
}

export const makeLocalDecisionEndpoint = Effect.fn("LocalDecision.make")(function* (
  manifest: DecisionManifest
) {
  const llama = yield* LlamaServer
  return localDecisionEndpoint(llama, manifest)
})
