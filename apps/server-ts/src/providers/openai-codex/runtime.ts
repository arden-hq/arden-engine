import { HttpStatusError, retrying } from "@arden-hq/loop/provider-kit"
import { retryAfterHints } from "@arden-hq/std/retry"
import { makeCodexApprovalReview } from "./approval-review.js"
import type { ApprovalReviewSource, TranscriptionSource } from "../../models/provider.js"
import { NodeHttpClient } from "@effect/platform-node"
import { resolveModelCapabilities, type ModelProvider } from "@arden-hq/loop"
import { Effect, Predicate } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { release } from "node:os"
import { resolveCodexClientVersion, type HttpGet } from "./version.js"
import type { ModelHost } from "../../models/host.js"
import type { PlanLimitsSource } from "../../models/plan-limits.js"
import { OPENAI_IMAGE_INPUT } from "../../lib/prompt-image.js"
import { makeCodexPlanLimits } from "./plan-limits.js"
import {
  makeOpenAiResponsesProvider,
  type OpenAiCredentialSnapshot,
  type OpenAiCredentialSource
} from "../openai-responses/index.js"

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

const MODEL_PREFIX = "openai-codex/"
const PROVIDER = Object.freeze({ id: "openai-codex", name: "OpenAI Codex" })
const CATALOG_TIMEOUT_MS = 5_000

class CodexAuthenticationError extends Error {}

interface CatalogModel {
  readonly slug: string
  readonly name: string
  readonly contextWindow: number
  readonly efforts: ReadonlyArray<string>
  readonly defaultEffort: string | null
  readonly priority: number
}

const nodeHttpGet: HttpGet = (url, options) =>
  nodeHttp(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(options.headers ?? {})),
    options.signal
  )

const nodeHttp = (
  request: HttpClientRequest.HttpClientRequest,
  signal: AbortSignal | undefined
): Promise<Response> => {
  const program = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request)
    const body = yield* response.text
    return new Response(body, {
      status: response.status,
      headers: response.headers
    })
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp))
  if (signal === undefined) return Effect.runPromise(program)
  return Effect.runPromise(program, { signal }).catch((error: unknown) => {
    throw signal.aborted ? signal.reason : error
  })
}

export interface OpenAiCodexRuntimeOptions {
  readonly credentials: OpenAiCredentialSource
  readonly initialCredential: OpenAiCredentialSnapshot
  readonly baseUrl?: string
  readonly httpGet?: HttpGet
  readonly catalogTimeoutMs?: number
  readonly appVersion?: string
  readonly resolveClientVersion?: () => Promise<string>
}

export interface OpenAiCodexRuntime {
  readonly modelHost: ModelHost
  readonly provider: ModelProvider
  readonly refreshModelHost: () => Promise<ModelHost>
  readonly approvalReview: ApprovalReviewSource
  readonly planLimits: PlanLimitsSource
  readonly transcription: TranscriptionSource
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const positiveInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && typeof value === "number" && value > 0

const finiteInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && typeof value === "number"

const decodeCatalog = (payload: unknown): ReadonlyArray<CatalogModel> => {
  if (!Predicate.isObject(payload) || !Array.isArray(payload.models))
    throw new Error("Invalid Codex model catalog")
  const seen = new Set<string>()
  const models: Array<CatalogModel> = []

  for (const raw of payload.models) {
    if (!Predicate.isObject(raw)) throw new Error("Invalid Codex model catalog entry")
    if (raw.visibility !== "list") continue
    let contextWindow: number | null = null
    if (positiveInt(raw.context_window)) contextWindow = raw.context_window
    else if (positiveInt(raw.max_context_window)) contextWindow = raw.max_context_window
    if (
      !nonEmpty(raw.slug) ||
      contextWindow === null ||
      !Array.isArray(raw.supported_reasoning_levels)
    ) {
      throw new Error("Invalid Codex model catalog entry")
    }
    if (seen.has(raw.slug)) throw new Error("Duplicate Codex model")
    seen.add(raw.slug)
    const efforts = raw.supported_reasoning_levels
      .flatMap((level) =>
        Predicate.isObject(level) && nonEmpty(level.effort) ? [level.effort] : []
      )
      .filter((effort, index, all) => all.indexOf(effort) === index && effort !== "ultra")
    const advertisedDefault =
      nonEmpty(raw.default_reasoning_level) && efforts.includes(raw.default_reasoning_level)
        ? raw.default_reasoning_level
        : null
    models.push({
      slug: raw.slug,
      name: nonEmpty(raw.display_name) ? raw.display_name : raw.slug,
      contextWindow,
      efforts,
      defaultEffort:
        advertisedDefault ?? (efforts.includes("medium") ? "medium" : (efforts[0] ?? null)),
      priority: finiteInt(raw.priority) ? raw.priority : Number.MAX_SAFE_INTEGER
    })
  }

  return models.sort((left, right) => left.priority - right.priority)
}

const codexClientHeaders = (
  appVersion: string | undefined,
  clientVersion: string
): Readonly<Record<string, string>> => ({
  originator: "arden",
  version: clientVersion,
  "user-agent": `Arden/${appVersion ?? "development"} (${process.platform} ${release()}; ${process.arch})`
})

const requestHeaders = (
  credential: OpenAiCredentialSnapshot,
  appVersion: string | undefined,
  clientVersion: string
): Readonly<Record<string, string>> => ({
  ...codexClientHeaders(appVersion, clientVersion),
  ...credential.headers,
  authorization: `Bearer ${credential.accessToken}`
})

const fetchLiveCatalog = async (
  options: OpenAiCodexRuntimeOptions,
  baseUrl: string,
  clientVersion: string
): Promise<ReadonlyArray<CatalogModel>> => {
  const signal = AbortSignal.timeout(options.catalogTimeoutMs ?? CATALOG_TIMEOUT_MS)
  const httpGet = options.httpGet ?? nodeHttpGet
  const url = new URL(`${baseUrl}/models`)
  url.searchParams.set("client_version", clientVersion)
  let credential = options.initialCredential
  let response = await httpGet(url.href, {
    headers: requestHeaders(credential, options.appVersion, clientVersion),
    signal
  })
  if (response.status === 403) throw new CodexAuthenticationError()
  if (response.status === 401) {
    try {
      credential = await options.credentials.get({ signal, forceRefresh: true })
      if (!nonEmpty(credential?.accessToken)) throw new Error("Invalid credential")
    } catch {
      throw new CodexAuthenticationError()
    }
    response = await httpGet(url.href, {
      headers: requestHeaders(credential, options.appVersion, clientVersion),
      signal
    })
    if (response.status === 401 || response.status === 403) throw new CodexAuthenticationError()
  }
  if (!response.ok) throw new Error("Codex model catalog request failed")
  return decodeCatalog(await response.json())
}

const sendSignedIn = async (
  options: OpenAiCodexRuntimeOptions,
  {
    baseUrl,
    clientVersion,
    path,
    signal
  }: {
    readonly baseUrl: string
    readonly clientVersion: string
    readonly path: string
    readonly signal: AbortSignal
  },
  send: (url: string, headers: Readonly<Record<string, string>>) => Promise<Response>
): Promise<Response> => {
  const url = `${baseUrl.replace(/\/codex$/, "")}/${path}`
  const attempt = async (forceRefresh: boolean) => {
    const credential = await options.credentials.get({ signal, forceRefresh })
    return send(url, requestHeaders(credential, options.appVersion, clientVersion))
  }
  const response = await attempt(false)
  return response.status === 401 ? attempt(true) : response
}

const fetchUsage = async (
  options: OpenAiCodexRuntimeOptions,
  baseUrl: string,
  clientVersion: string,
  signal: AbortSignal
): Promise<unknown> => {
  const httpGet = options.httpGet ?? nodeHttpGet
  const response = await sendSignedIn(
    options,
    { baseUrl, clientVersion, path: "wham/usage", signal },
    (url, headers) => httpGet(url, { headers, signal })
  )
  if (!response.ok) throw new Error(`Codex usage request failed (HTTP ${response.status})`)
  return response.json()
}

/** Codex desktop's dictation: one multipart `file` part, answered with `{ text }`.
 *  It goes over node:http: ChatGPT's edge answers global fetch's request with a
 *  Cloudflare 403 and the same request over node:http with 200 (2026-10-26). */
const transcribe = async (
  options: OpenAiCodexRuntimeOptions,
  baseUrl: string,
  clientVersion: string,
  audio: { readonly bytes: Uint8Array; readonly mediaType: string },
  signal: AbortSignal
): Promise<string> => {
  const extension = audio.mediaType.split(/[/;]/)[1] ?? "webm"
  const response = await retrying(async () => {
    const answer = await sendSignedIn(
      options,
      { baseUrl, clientVersion, path: "transcribe", signal },
      (url, headers) => {
        const form = new FormData()
        form.append(
          "file",
          new Blob([audio.bytes], { type: audio.mediaType }),
          `arden.${extension}`
        )
        return nodeHttp(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyFormData(form)
          ),
          signal
        )
      }
    )
    if (answer.ok) return answer
    throw new HttpStatusError(`Transcription failed (HTTP ${answer.status})`, {
      status: answer.status,
      ...retryAfterHints(answer.headers),
      code: "provider_unavailable"
    })
  }, signal)
  const body: unknown = await response.json()
  if (!Predicate.hasProperty(body, "text") || typeof body.text !== "string")
    throw new Error("Transcription returned no text")
  return body.text
}

const modelId = (slug: string): string => `${MODEL_PREFIX}${slug}`

const CHAT_MODEL_PREFERENCE = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.5"] as const
const HELPER_MODEL_PREFERENCE = ["gpt-6.1-luna", "gpt-6-luna", "gpt-5.4-mini"] as const

const makeHost = (catalog: ReadonlyArray<CatalogModel>): ModelHost => {
  const models = catalog.map((model) => ({
    id: modelId(model.slug),
    name: model.name,
    provider: PROVIDER,
    reasoningEfforts: [...model.efforts],
    context: {
      hardLimit: model.contextWindow,
      compactionTrigger: Math.floor(model.contextWindow * 0.76)
    }
  }))
  const ids = new Set(models.map((model) => model.id))
  const first = models[0]?.id ?? null
  const pick = (slugs: ReadonlyArray<string>): string | null =>
    slugs.map(modelId).find((id) => ids.has(id)) ?? first
  const chat = pick(CHAT_MODEL_PREFERENCE)
  const small = pick(HELPER_MODEL_PREFERENCE)
  const defaults = Object.fromEntries(
    catalog.flatMap((model) =>
      model.defaultEffort === null ? [] : [[modelId(model.slug), model.defaultEffort]]
    )
  )
  return {
    models,
    defaults: {
      chatModelId: chat,
      reasoningEfforts: defaults,
      roles: {
        background: { modelId: chat, reasoningEffort: null },
        helper: { modelId: small, reasoningEffort: null }
      }
    }
  }
}

export const makeOpenAiCodexRuntime = async (
  options: OpenAiCodexRuntimeOptions
): Promise<OpenAiCodexRuntime | null> => {
  const baseUrl = (options.baseUrl ?? CODEX_BASE_URL).replace(/\/+$/, "")
  const resolveVersion =
    options.resolveClientVersion ??
    (() => resolveCodexClientVersion({ httpGet: options.httpGet ?? nodeHttpGet }))
  let clientVersion: string | undefined
  const planLimits = makeCodexPlanLimits(async (signal) =>
    fetchUsage(options, baseUrl, clientVersion ?? (await resolveVersion()), signal)
  )
  const discover = async (initialCredential: OpenAiCredentialSnapshot) => {
    const version = await resolveVersion()
    clientVersion = version
    const catalog = await fetchLiveCatalog({ ...options, initialCredential }, baseUrl, version)
    if (catalog.length === 0) throw new Error("Codex returned no visible models")
    return {
      modelHost: makeHost(catalog),
      approvalReview: makeCodexApprovalReview({
        baseUrl,
        credentials: options.credentials,
        modelPrefix: MODEL_PREFIX,
        headers: codexClientHeaders(options.appVersion, version),
        fetch: planLimits.observingFetch(globalThis.fetch)
      }),
      provider: makeOpenAiResponsesProvider({
        baseUrl,
        credentials: options.credentials,
        modelPrefix: MODEL_PREFIX,
        headers: {
          ...codexClientHeaders(options.appVersion, version),
          "OpenAI-Beta": "responses_websockets=2026-02-06"
        },
        fetch: planLimits.observingFetch(globalThis.fetch),
        transport: () => "websocket",
        observeWebSocketHeaders: planLimits.observeHeaders,
        observeWebSocketEvent: planLimits.observeEvent,
        capabilities: () => ({
          agentMessages: "native",
          asyncTools: "message",
          steering: "boundary",
          hostedTools: ["web_search"],
          structuredOutput: "native",
          // Codex uses client-executed tool_search on this backend (codex-rs tools/src/tool_search.rs).
          toolSearch: "client",
          imageInput: OPENAI_IMAGE_INPUT
        }),
        omitMaxOutputTokens: true,
        cacheScopeHeader: "session-id"
      })
    }
  }
  const initial = await discover(options.initialCredential).catch((error: unknown) => {
    if (error instanceof CodexAuthenticationError) return null
    throw error
  })
  if (initial === null) return null
  let current = initial
  let pending: Promise<ModelHost> | undefined
  return {
    modelHost: initial.modelHost,
    approvalReview: {
      modelId: initial.approvalReview.modelId,
      complete: (input) => current.approvalReview.complete(input)
    },
    planLimits: {
      latest: planLimits.latest,
      history: planLimits.history,
      refresh: planLimits.refresh,
      onReading: planLimits.onReading
    },
    transcription: {
      transcribe: async (audio, signal) =>
        transcribe(options, baseUrl, clientVersion ?? (await resolveVersion()), audio, signal)
    },
    provider: {
      protocolVersion: 1,
      capabilities: (model) => resolveModelCapabilities({ provider: current.provider, model }),
      openSession: () =>
        current.provider.openSession?.() ?? {
          stream: current.provider.stream,
          close: () => undefined
        },
      stream: (request) => current.provider.stream(request)
    },
    refreshModelHost: () => {
      pending ??= options.credentials
        .get({ signal: AbortSignal.timeout(options.catalogTimeoutMs ?? CATALOG_TIMEOUT_MS) })
        .then(discover)
        .then((next) => {
          current = next
          return next.modelHost
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    }
  }
}
