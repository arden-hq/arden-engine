import type { ChatCompletionsCompat } from "@arden-hq/loop/providers/chat-completions"
import { unreachableMessage } from "@arden-hq/loop/provider-kit"
import { Option, Schema } from "effect"

export const CHAT_COMPLETIONS_SERVER = {
  llamaCpp: "llama.cpp",
  openrouter: "openrouter",
  generic: "generic"
} as const
export type ChatCompletionsServer =
  (typeof CHAT_COMPLETIONS_SERVER)[keyof typeof CHAT_COMPLETIONS_SERVER]
export const CHAT_COMPLETIONS_SERVERS = Object.values(CHAT_COMPLETIONS_SERVER)

export interface DiscoveredModel {
  readonly id: string
  readonly contextLimit: number | undefined
  readonly outputCap: number | undefined
  readonly reasoningEfforts: ReadonlyArray<string>
  readonly compat: Partial<ChatCompletionsCompat>
}

export type DiscoveryFailure =
  | { readonly reason: "not_llama_cpp"; readonly url: string; readonly status: number }
  | { readonly reason: "no_model_list"; readonly url: string; readonly status: number }
  | { readonly reason: "no_model" }
  | { readonly reason: "several_models"; readonly listed: ReadonlyArray<string> }
  | {
      readonly reason: "model_missing"
      readonly server: "llama.cpp" | "openrouter"
      readonly model: string
      readonly listed: ReadonlyArray<string>
    }
  | {
      readonly reason: "model_props_failed"
      readonly model: string
      readonly url: string
      readonly status: number
      readonly message: string | undefined
    }
  | {
      readonly reason: "no_tool_calls"
      readonly server: "llama.cpp" | "openrouter"
      readonly model: string
    }

export class DiscoveryError extends Error {
  readonly failure: DiscoveryFailure

  constructor(failure: DiscoveryFailure) {
    super(settingsMessage(failure))
    this.name = "DiscoveryError"
    this.failure = failure
  }
}

const settingsMessage = (failure: DiscoveryFailure): string => {
  switch (failure.reason) {
    case "not_llama_cpp":
      return `${failure.url} did not answer as llama.cpp (HTTP ${failure.status}); set \`server\``
    case "no_model_list":
      return `${failure.url} did not list models (HTTP ${failure.status})`
    case "no_model":
      return "The llama.cpp server lists no model"
    case "several_models":
      return `The llama.cpp server lists several models; set \`model\` to one of: ${failure.listed.join(", ")}`
    case "model_missing":
      return failure.server === "openrouter"
        ? `Model is not on OpenRouter: ${failure.model}`
        : `Model is not on the llama.cpp server: ${failure.model} (it lists: ${failure.listed.join(", ")})`
    case "model_props_failed":
      return `${failure.url} for ${failure.model} answered HTTP ${failure.status}${failure.message === undefined ? "" : `: ${failure.message}`}`
    case "no_tool_calls":
      return failure.server === "openrouter"
        ? `OpenRouter lists no tool calls for ${failure.model}, and every Arden request declares tools`
        : `The chat template of ${failure.model} has no tool calls, and every Arden request declares tools`
  }
}

export class UnreachableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "UnreachableError"
  }
}

export interface DiscoveryInput {
  readonly baseUrl: string
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

export const detectServer = async (input: DiscoveryInput): Promise<ChatCompletionsServer> => {
  if (new URL(input.baseUrl).hostname === "openrouter.ai") return "openrouter"
  const props = await getJson(input, `${serverRoot(input.baseUrl)}/props`)
  return props.status === 200 && Option.isSome(decodeFingerprint(props.body))
    ? "llama.cpp"
    : "generic"
}

export const discoverLlamaCpp = async (
  input: DiscoveryInput,
  wanted: ReadonlyArray<string> | undefined
): Promise<ReadonlyArray<DiscoveredModel>> => {
  const server = await llamaServer(input)
  const ids = server.models.map((model) => model.id)
  if (wanted === undefined && ids.length !== 1)
    throw new DiscoveryError(
      ids.length === 0 ? { reason: "no_model" } : { reason: "several_models", listed: ids }
    )
  return Promise.all((wanted ?? ids).map((id) => llamaEntry(input, server, id)))
}

export type LlamaListing =
  | { readonly id: string; readonly kind: "usable"; readonly model: DiscoveredModel }
  | { readonly id: string; readonly kind: "refused"; readonly failure: DiscoveryFailure }

export const listLlamaCpp = async (input: DiscoveryInput): Promise<ReadonlyArray<LlamaListing>> => {
  const server = await llamaServer(input)
  if (server.models.length === 0) throw new DiscoveryError({ reason: "no_model" })
  return Promise.all(
    server.models.map(async ({ id }): Promise<LlamaListing> => {
      try {
        return { id, kind: "usable", model: await llamaEntry(input, server, id) }
      } catch (cause) {
        if (cause instanceof DiscoveryError) return { id, kind: "refused", failure: cause.failure }
        throw cause
      }
    })
  )
}

interface LlamaServer {
  readonly root: string
  readonly props: typeof PropsSchema.Type
  readonly models: (typeof LlamaModelsSchema.Type)["data"]
}

const llamaServer = async (input: DiscoveryInput): Promise<LlamaServer> => {
  const root = serverRoot(input.baseUrl)
  const rootProps = await getJson(input, `${root}/props`)
  const props = decodeProps(rootProps.body)
  if (rootProps.status !== 200 || Option.isNone(props))
    throw new DiscoveryError({
      reason: "not_llama_cpp",
      url: `${root}/props`,
      status: rootProps.status
    })
  const listed = await getJson(input, `${input.baseUrl}/models`)
  const models = decodeLlamaModels(listed.body)
  if (listed.status !== 200 || Option.isNone(models))
    throw new DiscoveryError({
      reason: "no_model_list",
      url: `${input.baseUrl}/models`,
      status: listed.status
    })
  return { root, props: props.value, models: models.value.data }
}

const llamaEntry = async (
  input: DiscoveryInput,
  server: LlamaServer,
  id: string
): Promise<DiscoveredModel> => {
  const { root } = server
  const listing = server.models.find((model) => model.id === id)
  if (listing === undefined)
    throw new DiscoveryError({
      reason: "model_missing",
      server: "llama.cpp",
      model: id,
      listed: server.models.map((model) => model.id)
    })
  if (server.props.role !== "router") return llamaModel(id, server.props, undefined)
  const own = await getJson(input, `${root}/props?model=${encodeURIComponent(id)}&autoload=false`)
  const loaded = decodeProps(own.body)
  if (own.status === 200 && Option.isSome(loaded)) return llamaModel(id, loaded.value, undefined)
  const message = Option.getOrUndefined(decodeErrorMessage(own.body))
  if (own.status === 400 && message === NOT_LOADED)
    return llamaModel(id, undefined, ctxSizeArgument(listing.status?.args ?? []))
  throw new DiscoveryError({
    reason: "model_props_failed",
    model: id,
    url: `${root}/props`,
    status: own.status,
    message
  })
}

/**
 * One model on OpenRouter, from its public model list (it needs no key:
 * checked against https://openrouter.ai/api/v1/models on 2026-11-15).
 * Parameters: https://openrouter.ai/docs/api/reference/parameters
 */
export const discoverOpenRouter = async (
  input: DiscoveryInput,
  wanted: ReadonlyArray<string>
): Promise<ReadonlyArray<DiscoveredModel>> => {
  const listed = await getJson(input, `${input.baseUrl}/models`)
  const list = decodeList(listed.body)
  if (listed.status !== 200 || Option.isNone(list))
    throw new DiscoveryError({
      reason: "no_model_list",
      url: `${input.baseUrl}/models`,
      status: listed.status
    })
  return wanted.map((id) => {
    const entry = list.value.data.find((item) => Option.isSome(decodeEntryId(item, id)))
    const model = entry === undefined ? Option.none() : decodeOpenRouterModel(entry)
    if (Option.isNone(model))
      throw new DiscoveryError({
        reason: "model_missing",
        server: "openrouter",
        model: id,
        listed: []
      })
    return openRouterModel(model.value)
  })
}

const llamaModel = (
  id: string,
  props: typeof PropsSchema.Type | undefined,
  ctxSize: number | undefined
): DiscoveredModel => {
  const caps = props?.chat_template_caps
  if (caps?.supports_tools === false)
    throw new DiscoveryError({ reason: "no_tool_calls", server: "llama.cpp", model: id })
  const contextLimit = positive(props?.default_generation_settings?.n_ctx) ?? positive(ctxSize)
  const levels =
    caps?.supports_reasoning_effort === true ? (caps.reasoning_effort_levels ?? []) : []
  const efforts = ["none", ...levels.filter((level) => level !== "none")]
  return {
    id,
    contextLimit,
    outputCap: undefined,
    reasoningEfforts: efforts,
    compat: {
      maxTokensField: "max_tokens",
      systemRole: "system",
      reasoningEffort: "reasoning_effort",
      usageInStream: true,
      structuredOutput: "json_schema",
      imageInput: props?.modalities?.vision === true,
      parallelToolCalls: caps?.supports_parallel_tool_calls === true,
      cacheControl: "none",
      toolChoiceNone: "unenforced"
    }
  }
}

const openRouterModel = (model: typeof OpenRouterModelSchema.Type): DiscoveredModel => {
  const parameters = model.supported_parameters ?? []
  if (!parameters.includes("tools"))
    throw new DiscoveryError({ reason: "no_tool_calls", server: "openrouter", model: model.id })
  const reasoning = parameters.includes("reasoning")
  return {
    id: model.id,
    contextLimit: smallest([model.context_length, model.top_provider?.context_length]),
    outputCap: positive(model.top_provider?.max_completion_tokens),
    reasoningEfforts: reasoning ? openRouterEfforts(model.reasoning ?? undefined) : [],
    compat: {
      maxTokensField:
        parameters.includes("max_tokens") || !parameters.includes("max_completion_tokens")
          ? "max_tokens"
          : "max_completion_tokens",
      systemRole: "system",
      reasoningEffort: reasoning ? "openrouter" : "none",
      // Usage is always in the last chunk: https://openrouter.ai/docs/guides/guides/usage-accounting
      usageInStream: true,
      structuredOutput: parameters.includes("structured_outputs") ? "json_schema" : "none",
      imageInput: model.architecture?.input_modalities?.includes("image") === true,
      parallelToolCalls: parameters.includes("parallel_tool_calls"),
      cacheControl: explicitCache(model.id) ? "anthropic" : "none"
    }
  }
}

/**
 * A model's efforts as https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 * describes them (read 2026-11-16): `supported_efforts` lists them; `null`
 * means every gateway value; left out, the model offers no effort choice and
 * reasons at its own default. `mandatory` models reject `none`.
 *
 * Checked live on 2026-11-16: the gateway takes exactly the seven values of
 * `OPENROUTER_EFFORTS` and refuses any other with a 400 naming them; a value
 * a model does not list is mapped to its nearest level, not refused (`max`
 * on Gemini 4 Hydrogen, `minimal` on GPT-6 Luna and Claude Haiku 5.5,
 * `medium` on DeepSeek V4.1 Flash all answered); `none` on a mandatory model
 * (GPT-6.1 Sol, Claude Sonnet 5.5, GLM 5.3 Flash) is refused with "Reasoning
 * is mandatory for this endpoint and cannot be disabled." So the listed efforts
 * are the ones offered, and `none` only where reasoning is optional.
 */
const openRouterEfforts = (
  reasoning: (typeof OpenRouterModelSchema.Type)["reasoning"] | undefined
): ReadonlyArray<string> => {
  const listed = reasoning?.supported_efforts
  if (listed === undefined) return []
  const efforts = listed ?? OPENROUTER_EFFORTS
  return reasoning?.mandatory === true ? efforts.filter((effort) => effort !== "none") : efforts
}

const OPENROUTER_EFFORTS = ["max", "xhigh", "high", "medium", "low", "minimal", "none"]

/**
 * Which OpenRouter models cache only at explicit `cache_control`
 * breakpoints, per https://openrouter.ai/docs/guides/best-practices/prompt-caching
 * (read 2026-11-16). Anthropic Claude: explicit breakpoints work on every
 * Claude provider (the top-level automatic form only on some). Alibaba:
 * "requires explicit cache breakpoints", on exactly these models; its
 * snapshot endpoints do not cache at all. Checked live for `qwen/qwen-plus`
 * on 2026-11-16: with the breakpoints a 35,329-token prompt wrote 35,313
 * tokens and the repeat read all of them at a tenth of the input price;
 * without them Alibaba still reused 35,200 implicitly, at a fifth. So the
 * breakpoints are worth sending there, though not the only way it caches.
 * `qwen/qwen3-max` and `qwen/qwen3-coder-plus` are no longer in the model
 * list (2026-11-16) and match nothing until they return. Every other family the page
 * covers caches by prefix on its own: OpenAI, Grok, Moonshot, Groq,
 * DeepSeek, Z.AI, and Gemini 2.5 and newer ("implicit caching ... no
 * `cache_control` breakpoints required"; Gemini's explicit breakpoints are
 * an optional extra with storage cost, so they are not sent).
 */
const EXPLICIT_CACHE: {
  readonly prefixes: ReadonlyArray<string>
  readonly ids: ReadonlySet<string>
} = {
  prefixes: ["anthropic/"],
  ids: new Set([
    "deepseek/deepseek-v3.2",
    "qwen/qwen3-max",
    "qwen/qwen-plus",
    "qwen/qwen3.6-plus",
    "qwen/qwen3-coder-plus",
    "qwen/qwen3-coder-flash"
  ])
}

const explicitCache = (name: string): boolean =>
  EXPLICIT_CACHE.ids.has(name) || EXPLICIT_CACHE.prefixes.some((prefix) => name.startsWith(prefix))

const serverRoot = (baseUrl: string): string => baseUrl.replace(/\/v1$/, "")

const NOT_LOADED = "model is not loaded"

const decodeErrorMessage = (body: unknown): Option.Option<string> =>
  Option.map(decodeErrorBody(body), (decoded) => decoded.error.message)

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
)

const ctxSizeArgument = (args: ReadonlyArray<string>): number | undefined => {
  const at = args.indexOf("--ctx-size")
  return at === -1 ? undefined : Number(args[at + 1])
}

const positive = (value: number | null | undefined): number | undefined =>
  value !== null && value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined

const smallest = (values: ReadonlyArray<number | null | undefined>): number | undefined => {
  const known = values.flatMap((value) => {
    const kept = positive(value)
    return kept === undefined ? [] : [kept]
  })
  return known.length === 0 ? undefined : Math.min(...known)
}

const getJson = async (
  input: DiscoveryInput,
  url: string
): Promise<{ readonly status: number; readonly body: unknown }> => {
  try {
    const response = await input.fetch(url, { headers: input.headers, signal: input.signal })
    const text = await response.text()
    return { status: response.status, body: Option.getOrUndefined(decodeJsonText(text)) }
  } catch (cause) {
    throw new UnreachableError(unreachableMessage(url, cause), { cause })
  }
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const FingerprintSchema = Schema.Struct({ build_info: Schema.String })
const decodeFingerprint = Schema.decodeUnknownOption(FingerprintSchema)

const PropsSchema = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  default_generation_settings: Schema.optionalKey(
    Schema.Struct({ n_ctx: Schema.optionalKey(Schema.Number) })
  ),
  modalities: Schema.optionalKey(Schema.Struct({ vision: Schema.optionalKey(Schema.Boolean) })),
  chat_template_caps: Schema.optionalKey(
    Schema.Struct({
      supports_tools: Schema.optionalKey(Schema.Boolean),
      supports_parallel_tool_calls: Schema.optionalKey(Schema.Boolean),
      supports_reasoning_effort: Schema.optionalKey(Schema.Boolean),
      reasoning_effort_levels: Schema.optionalKey(Schema.Array(Schema.String))
    })
  )
})
const decodeProps = Schema.decodeUnknownOption(PropsSchema)

const LlamaModelsSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.optionalKey(
        Schema.Struct({ args: Schema.optionalKey(Schema.Array(Schema.String)) })
      )
    })
  )
})
const decodeLlamaModels = Schema.decodeUnknownOption(LlamaModelsSchema)

const decodeList = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))

const decodeEntryId = (item: unknown, id: string) =>
  Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Literal(id) }))(item)

const OpenRouterModelSchema = Schema.Struct({
  id: Schema.String,
  context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  top_provider: Schema.optionalKey(
    Schema.Struct({
      context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      max_completion_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number))
    })
  ),
  supported_parameters: Schema.optionalKey(Schema.Array(Schema.String)),
  architecture: Schema.optionalKey(
    Schema.Struct({ input_modalities: Schema.optionalKey(Schema.Array(Schema.String)) })
  ),
  reasoning: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        supported_efforts: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
        mandatory: Schema.optionalKey(Schema.Boolean)
      })
    )
  )
})
const decodeOpenRouterModel = Schema.decodeUnknownOption(OpenRouterModelSchema)
