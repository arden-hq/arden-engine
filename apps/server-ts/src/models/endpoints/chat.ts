import { ROLE } from "@arden-hq/std/message-vocabulary"
import {
  providerErrorCode,
  ToolChoice,
  type ModelProvider,
  type ProviderErrorCode
} from "@arden-hq/loop"
import {
  CHAT_ENDPOINT_MIN_WINDOW,
  type ChatEndpointCheckFailure,
  type ChatEndpointService,
  type ChatEndpointSkip
} from "@arden-hq/protocol/model-endpoints"
import { errorMessage } from "@arden-hq/std/errors"
import { baseUrlIssue } from "@arden-hq/std/url"
import {
  discoverOpenRouter,
  DiscoveryError,
  listLlamaCpp,
  UnreachableError,
  type ChatCompletionsServer,
  type DiscoveredModel,
  type DiscoveryFailure
} from "../../providers/chat-completions/discovery.js"
import {
  CHAT_COMPLETIONS_HOSTS,
  chatCompletionsDefinition,
  chatCompletionsProvider,
  connectionOf,
  declaredModel,
  discoveryInput,
  type ChatCompletionsConnection
} from "../../providers/chat-completions/route.js"
import { CODEX_MODEL_PREFIX } from "../../providers/openai-codex/runtime.js"
import type {
  StoredChatEndpoint,
  StoredChatModel
} from "../../persistence/model-endpoints/store.js"
import type { ModelDefinition } from "../host.js"
import { type EndpointFailureReason, failureForStatus } from "./failure.js"

/**
 * The desktop's model servers: what a Check proves about one, and the models
 * and adapters a saved one adds to the model list. Discovery, request shapes
 * and model definitions come from the shared Chat Completions builder
 * (`providers/chat-completions/route.ts`); this file adds only the desktop's
 * rules: models offered only when they call tools and have
 * `CHAT_ENDPOINT_MIN_WINDOW`, ids that never collide with Codex's or another
 * saved server's, a group name per server.
 */

/** Which discovery each service runs. A custom server is asked nothing. */
const SERVER_OF: Record<ChatEndpointService, ChatCompletionsServer> = {
  "llama.cpp": "llama.cpp",
  openrouter: "openrouter",
  custom: "generic"
}

/** What names a server's group in the model picker. */
export interface ChatServerIdentity {
  readonly id: string
  readonly service: ChatEndpointService
  readonly baseUrl: string
}

/**
 * Each server's group in the model picker, by server id. The name is the
 * service's, or a custom server's host (never "local"); servers that would
 * share a name each add their host. The model host wants one name per
 * provider id, so the id is the server's own, never the service's: two
 * llama.cpp servers are two groups.
 */
export const chatGroups = (
  servers: ReadonlyArray<ChatServerIdentity>
): ReadonlyMap<string, ModelDefinition["provider"]> => {
  const named = servers.map((server) => {
    const host = new URL(server.baseUrl).host
    const name =
      server.service === "custom" ? host : CHAT_COMPLETIONS_HOSTS[SERVER_OF[server.service]].name
    return { id: server.id, host, name }
  })
  const shared = (name: string) => named.filter((server) => server.name === name).length > 1
  return new Map(
    named.map((server) => [
      server.id,
      {
        id: `model-server-${server.id}`,
        name:
          shared(server.name) && server.name !== server.host
            ? `${server.name} · ${server.host}`
            : server.name
      }
    ])
  )
}

/**
 * The model ids other saved servers offer, each with its server's group
 * name. A chat's stored model id names one server, so none may be offered
 * twice.
 */
export type TakenModels = ReadonlyMap<string, string>

/** What the person asked to check, with the key already resolved. */
export type ChatEndpointTarget = (
  | { readonly service: "llama.cpp" }
  | { readonly service: "openrouter" | "custom"; readonly models: ReadonlyArray<string> }
) & {
  readonly baseUrl: string
  readonly key: string | undefined
  readonly fetch: typeof globalThis.fetch
}

export type ChatDiscovery =
  | {
      readonly result: "works"
      readonly models: ReadonlyArray<StoredChatModel>
      readonly skipped: ReadonlyArray<ChatEndpointSkip>
    }
  | ChatEndpointCheckFailure

/** How long discovery may take: the same as the configured server's start. */
const DISCOVERY_TIMEOUT_MS = 15_000
/**
 * How long the Check's one chat request may take. A llama.cpp router loads a
 * model on its first request, which takes seconds for a large GGUF.
 */
const CHAT_REQUEST_TIMEOUT_MS = 60_000
/**
 * The Check's answer budget: enough for a model to say a word, little enough
 * to cost nothing. A model that spends it thinking still answers in the
 * format, which is what the request proves.
 */
const CHECK_OUTPUT_TOKENS = 32

/**
 * Discovery as the Check and the start-up re-probe run it: no chat request.
 * llama.cpp offers every listed model Arden can use, and skips the rest;
 * OpenRouter and a custom server offer every named model, or fail on the
 * first that cannot be offered, since the person asked for each. A custom
 * server reports neither its windows nor whether it calls tools: its models
 * are taken to have `CHAT_ENDPOINT_MIN_WINDOW`, and the Check's chat request
 * declares a tool so a server that refuses tools fails there.
 */
export const discoverChatEndpoint = async (
  target: ChatEndpointTarget,
  taken: TakenModels
): Promise<ChatDiscovery> => {
  const issue = baseUrlIssue(target.baseUrl, {
    http: target.key === undefined ? "any" : "loopback"
  })
  if (issue !== undefined)
    return { result: "address_refused", issue, message: addressMessage(issue) }
  const connection = connectionOf(target)
  const input = discoveryInput(connection, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS))
  try {
    switch (target.service) {
      case "llama.cpp": {
        const listed = await listLlamaCpp(input)
        return offered(
          listed.map((entry) =>
            entry.kind === "usable"
              ? judged(entry.model, taken)
              : { kind: "skipped", skip: skipOf(entry.id, entry.failure) }
          ),
          { named: false, taken }
        )
      }
      case "openrouter":
        return offered(
          (await discoverOpenRouter(input, target.models)).map((model) => judged(model, taken)),
          { named: true, taken }
        )
      case "custom":
        return offered(
          target.models.map((id) =>
            judged(
              declaredModel({ id, contextLimit: CHAT_ENDPOINT_MIN_WINDOW, reasoningEfforts: [] }),
              taken
            )
          ),
          { named: true, taken }
        )
    }
  } catch (cause) {
    if (cause instanceof UnreachableError) return { result: "unreachable", message: cause.message }
    if (cause instanceof DiscoveryError) return discoveryFailure(cause.failure, cause.message)
    throw cause
  }
}

export type ChatCheck =
  | {
      readonly result: "works"
      readonly models: ReadonlyArray<StoredChatModel>
      readonly skipped: ReadonlyArray<ChatEndpointSkip>
      readonly ms: number
    }
  | ChatEndpointCheckFailure

/**
 * Discovery, then one small chat request to the first offered model: it
 * proves the key and the wire format. Only the first, so a Check of several
 * OpenRouter models costs one small request; the others' abilities come from
 * the model list. Thinking is off where the model offers `none`, and the
 * answer is capped at `CHECK_OUTPUT_TOKENS`.
 */
export const checkChatEndpoint = async (
  target: ChatEndpointTarget,
  {
    now = () => performance.now(),
    taken = new Map()
  }: { readonly now?: () => number; readonly taken?: TakenModels } = {}
): Promise<ChatCheck> => {
  const started = now()
  const discovered = await discoverChatEndpoint(target, taken)
  if (discovered.result !== "works") return discovered
  const [first] = discovered.models
  if (first === undefined) throw new Error("A working discovery offers a model")
  const answered = await askOnce({
    provider: chatCompletionsProvider({
      connection: connectionOf(target),
      providerId: CHAT_COMPLETIONS_HOSTS[SERVER_OF[target.service]].id,
      models: [discoveredOf(first)]
    }),
    model: first,
    declareTool: target.service === "custom"
  })
  if (answered !== undefined) return answered
  return { ...discovered, ms: Math.round(now() - started) }
}

/** A saved server's models as the host lists them, and the adapters that serve them. */
export interface ServerModels {
  readonly provider: ModelProvider
  readonly models: ReadonlyArray<ModelDefinition>
}

/**
 * A saved server's part of the model list, built from what it last reported:
 * no request is made, so a stopped server keeps its models. `report` hears
 * each request's outcome for the endpoint's health.
 */
export const serverModels = (input: {
  readonly stored: StoredChatEndpoint
  readonly group: ModelDefinition["provider"]
  readonly key: string | undefined
  readonly fetch: typeof globalThis.fetch
  readonly report: (failure: EndpointFailureReason | undefined) => void
}): ServerModels => {
  const { stored, group } = input
  const connection: ChatCompletionsConnection = connectionOf({
    baseUrl: stored.baseUrl,
    key: input.key,
    fetch: input.fetch
  })
  return {
    provider: observed(
      chatCompletionsProvider({
        connection,
        providerId: group.id,
        models: stored.models.map(discoveredOf)
      }),
      input.report
    ),
    models: stored.models.map((model) =>
      chatCompletionsDefinition({ group, model: discoveredOf(model), window: model.window })
    )
  }
}

type Judged =
  | { readonly kind: "offered"; readonly model: StoredChatModel }
  | { readonly kind: "skipped"; readonly skip: ChatEndpointSkip }

/** The desktop's rules for one discovered model. */
const judged = (model: DiscoveredModel, taken: TakenModels): Judged => {
  const skip = (detail: ChatEndpointSkip): Judged => ({ kind: "skipped", skip: detail })
  if (isTaken(model.id, taken)) return skip({ id: model.id, reason: "model_taken" })
  const window = model.contextLimit
  if (window === undefined) return skip({ id: model.id, reason: "window_unknown" })
  if (window < CHAT_ENDPOINT_MIN_WINDOW)
    return skip({ id: model.id, reason: "window_too_small", window })
  return {
    kind: "offered",
    model: {
      id: model.id,
      window,
      outputCap: model.outputCap ?? null,
      reasoningEfforts: model.reasoningEfforts,
      compat: model.compat
    }
  }
}

const isTaken = (modelName: string, taken: TakenModels): boolean =>
  modelName.startsWith(CODEX_MODEL_PREFIX) || taken.has(modelName)

/** The Check's `model_taken` for the first of `ids` that is taken. */
export const takenFailure = (
  ids: ReadonlyArray<string>,
  taken: TakenModels
): ChatEndpointCheckFailure | undefined => {
  const id = ids.find((model) => isTaken(model, taken))
  return id === undefined ? undefined : skipFailure({ id, reason: "model_taken" }, taken)
}

/**
 * A listing server works when one model is offered; a named one when every
 * named model is. Otherwise it fails with the first skipped model's reason.
 */
const offered = (
  entries: ReadonlyArray<Judged>,
  rules: { readonly named: boolean; readonly taken: TakenModels }
): ChatDiscovery => {
  const models = entries.flatMap((entry) => (entry.kind === "offered" ? [entry.model] : []))
  const skipped = entries.flatMap((entry) => (entry.kind === "skipped" ? [entry.skip] : []))
  const [first] = skipped
  if (models.length > 0 && (first === undefined || !rules.named))
    return { result: "works", models, skipped }
  if (first === undefined) return { result: "model_missing", model: null, message: NO_MODEL }
  return skipFailure(first, rules.taken)
}

/**
 * A re-asked server's answer without the ids another saved server took
 * since: those move to its skipped list as `model_taken`. Undefined when no
 * model is left.
 */
export const untaken = (
  found: Extract<ChatDiscovery, { readonly result: "works" }>,
  taken: TakenModels
): Extract<ChatDiscovery, { readonly result: "works" }> | undefined => {
  const models = found.models.filter((model) => !taken.has(model.id))
  if (models.length === 0) return undefined
  return {
    result: "works",
    models,
    skipped: [
      ...found.skipped,
      ...found.models.flatMap((model): ReadonlyArray<ChatEndpointSkip> =>
        taken.has(model.id) ? [{ id: model.id, reason: "model_taken" }] : []
      )
    ]
  }
}

const NO_MODEL = "The server lists no model"

const skipFailure = (skip: ChatEndpointSkip, taken: TakenModels): ChatEndpointCheckFailure => {
  switch (skip.reason) {
    case "no_tool_calls":
      return {
        result: "no_tool_calls",
        model: skip.id,
        message: `${skip.id} cannot call tools, and every Arden request declares tools`
      }
    case "window_too_small":
      return {
        result: "window_too_small",
        model: skip.id,
        window: skip.window,
        needed: CHAT_ENDPOINT_MIN_WINDOW,
        message: `${skip.id} has a ${skip.window}-token window; Arden needs ${CHAT_ENDPOINT_MIN_WINDOW}`
      }
    case "window_unknown":
      return {
        result: "window_unknown",
        model: skip.id,
        message: `The server does not report the window of ${skip.id}; load the model, then Check`
      }
    case "model_taken": {
      const owner = taken.get(skip.id)
      return {
        result: "model_taken",
        model: skip.id,
        message:
          owner === undefined
            ? `${skip.id} is named like a ChatGPT model (${CODEX_MODEL_PREFIX}…)`
            : `${skip.id} is offered by another model server (${owner})`
      }
    }
    case "wrong_format":
      return {
        result: "wrong_format",
        message: `The server did not describe ${skip.id} as llama.cpp does`
      }
  }
}

/** A model the server lists but cannot describe or rules out itself. */
const skipOf = (id: string, failure: DiscoveryFailure): ChatEndpointSkip =>
  failure.reason === "no_tool_calls"
    ? { id, reason: "no_tool_calls" }
    : { id, reason: "wrong_format" }

/** A whole-server discovery failure as the Check states it. */
const discoveryFailure = (failure: DiscoveryFailure, message: string): ChatEndpointCheckFailure => {
  switch (failure.reason) {
    case "not_llama_cpp":
    case "no_model_list":
      return { result: failureForStatus(failure.status), message }
    case "no_model":
      return { result: "model_missing", model: null, message: NO_MODEL }
    case "model_missing":
      return { result: "model_missing", model: failure.model, message }
    case "no_tool_calls":
      return skipFailure({ id: failure.model, reason: "no_tool_calls" }, new Map())
    case "several_models":
    case "model_props_failed":
      return { result: "wrong_format", message }
  }
}

const addressMessage = (issue: NonNullable<ReturnType<typeof baseUrlIssue>>): string => {
  switch (issue) {
    case "insecure":
      return "A key goes only over HTTPS, or plain HTTP to this Mac"
    case "invalid":
      return "The address is not a URL"
    case "credentials":
      return "The address must not contain a user name or password"
    case "fragment":
    case "query":
      return "The address must not contain ? or #: request paths are appended to it"
  }
}

const discoveredOf = (model: StoredChatModel): DiscoveredModel => ({
  id: model.id,
  contextLimit: model.window,
  outputCap: model.outputCap ?? undefined,
  reasoningEfforts: model.reasoningEfforts,
  compat: model.compat
})

/** The one tool a custom server's Check declares: every Arden request declares tools. */
const CHECK_TOOL = {
  name: "noop",
  description: "Does nothing. Do not call it.",
  parameters: { type: "object", properties: {}, additionalProperties: false }
}

/** Undefined when the model answered; otherwise why the request failed. */
const askOnce = async (input: {
  readonly provider: ModelProvider
  readonly model: StoredChatModel
  readonly declareTool: boolean
}): Promise<ChatEndpointCheckFailure | undefined> => {
  const { model } = input
  try {
    for await (const item of await input.provider.stream({
      messages: [{ role: ROLE.user, content: "Reply with the word OK." }],
      model: model.id,
      maxOutputTokens: CHECK_OUTPUT_TOKENS,
      ...(model.reasoningEfforts.includes("none") ? { reasoningEffort: "none" } : {}),
      tools: input.declareTool ? [CHECK_TOOL] : [],
      deferredTools: [],
      toolChoice: input.declareTool ? ToolChoice.AUTO : ToolChoice.NONE,
      renderInteraction: () => {
        throw new Error("The Check has no interactions")
      },
      signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT_MS)
    }))
      if (item._tag === "Completed") return undefined
    return { result: "wrong_format", message: "The answer ended without a completed response" }
  } catch (cause) {
    return requestFailure(providerErrorCode(cause), model.id, errorMessage(cause))
  }
}

const requestFailure = (
  code: ProviderErrorCode | undefined,
  model: string,
  message: string
): ChatEndpointCheckFailure => {
  switch (code) {
    case "provider_auth":
      return { result: "key_refused", message }
    // A server that is not answering, or limiting requests, may work at the next Check.
    case "provider_unavailable":
    case "rate_limited":
      return { result: "unreachable", message }
    case "model_unavailable":
      return { result: "model_missing", model, message }
    case "context_length_exceeded":
    case "request_invalid":
    case "provider_error":
    case undefined:
      return { result: "wrong_format", message }
  }
}

/** The health a request's failure says about the server; undefined says nothing. */
const healthFailure = (code: ProviderErrorCode | undefined): EndpointFailureReason | undefined => {
  switch (code) {
    case "provider_auth":
      return "key_refused"
    case "provider_unavailable":
      return "unreachable"
    case "rate_limited":
    case "model_unavailable":
    case "context_length_exceeded":
    case "request_invalid":
    case "provider_error":
    case undefined:
      return undefined
  }
}

/**
 * The server's adapters, reporting each request's outcome: a completed
 * answer says it works again, a refused key or a server that does not answer
 * marks it failing (as search and decision endpoints are marked).
 */
const observed = (
  provider: ModelProvider,
  report: (failure: EndpointFailureReason | undefined) => void
): ModelProvider => ({
  ...provider,
  async *stream(request) {
    try {
      for await (const item of await provider.stream(request)) {
        if (item._tag === "Completed") report(undefined)
        yield item
      }
    } catch (cause) {
      const failure = healthFailure(providerErrorCode(cause))
      if (failure !== undefined) report(failure)
      throw cause
    }
  }
})
