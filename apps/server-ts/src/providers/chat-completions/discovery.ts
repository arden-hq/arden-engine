import { errorMessage } from "@arden-hq/std/errors"
import { Option, Schema } from "effect"

/**
 * The servers a `chat-completions` provider knows how to ask about a model.
 * `generic` asks nothing: the settings carry the model and its window.
 */
export const CHAT_COMPLETIONS_SERVERS = ["llama.cpp", "openrouter", "generic"] as const
export type ChatCompletionsServer = (typeof CHAT_COMPLETIONS_SERVERS)[number]

/** How requests to one model are shaped; the adapter's `compat` option. */
export interface ModelCompat {
  readonly maxTokensField: "max_completion_tokens" | "max_tokens"
  readonly systemRole: "system" | "developer"
  readonly reasoningEffort: "reasoning_effort" | "openrouter" | "none"
  readonly usageInStream: boolean
  readonly structuredOutput: "json_schema" | "none"
  readonly imageInput: boolean
  readonly parallelToolCalls: boolean
  readonly cacheControl: "anthropic" | "none"
}

/** One model as its server reports it. */
export interface DiscoveredModel {
  readonly id: string
  /** The server's own window in tokens; undefined when it does not say. */
  readonly contextLimit: number | undefined
  readonly reasoningEfforts: ReadonlyArray<string>
  readonly compat: ModelCompat
}

/** The server cannot be asked, or its answer rules the settings out. */
export class DiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DiscoveryError"
  }
}

export interface DiscoveryInput {
  /** The provider's `baseUrl` without a trailing slash; model requests go to
   *  `${baseUrl}/chat/completions`. */
  readonly baseUrl: string
  readonly fetch: typeof globalThis.fetch
  /** Sent with every request: the key, when the provider has one. */
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

/**
 * Which server answers at `baseUrl`, for settings that do not say. An explicit
 * `server` always wins over this, as prime-agent's explicit `compat` wins over
 * its `detect_compat`: a proxy in front of llama.cpp can be named `generic`.
 * OpenRouter is known by its host. llama.cpp is known by `GET /props` carrying
 * `build_info`: Ollama and LM Studio answer `/v1/models` but not `/props`
 * (hermes-agent's fingerprint, `local_runtime/detect.py`). An unreachable
 * server is an error here, not `generic`, so a stopped server is reported as
 * stopped instead of as missing settings.
 */
export const detectServer = async (input: DiscoveryInput): Promise<ChatCompletionsServer> => {
  if (new URL(input.baseUrl).hostname === "openrouter.ai") return "openrouter"
  const props = await getJson(input, `${serverRoot(input.baseUrl)}/props`)
  return props.status === 200 && Option.isSome(decodeFingerprint(props.body))
    ? "llama.cpp"
    : "generic"
}

/**
 * The asked models on a llama.cpp server, in the order asked; undefined asks
 * for the server's only model. Discovery never loads a model: a router loads
 * one for any request that names it unless the request says `autoload=false`.
 */
export const discoverLlamaCpp = async (
  input: DiscoveryInput,
  wanted: ReadonlyArray<string> | undefined
): Promise<ReadonlyArray<DiscoveredModel>> => {
  const root = serverRoot(input.baseUrl)
  const rootProps = await getJson(input, `${root}/props`)
  const props = decodeProps(rootProps.body)
  if (rootProps.status !== 200 || Option.isNone(props))
    throw new DiscoveryError(
      `${root}/props did not answer as llama.cpp (HTTP ${rootProps.status}); set \`server\``
    )
  const listed = await getJson(input, `${input.baseUrl}/models`)
  const models = decodeLlamaModels(listed.body)
  if (listed.status !== 200 || Option.isNone(models))
    throw new DiscoveryError(`${input.baseUrl}/models did not list models (HTTP ${listed.status})`)
  const ids = models.value.data.map((model) => model.id)
  const names = ids.join(", ")
  if (wanted === undefined && ids.length !== 1)
    throw new DiscoveryError(
      ids.length === 0
        ? "The llama.cpp server lists no model"
        : `The llama.cpp server lists several models; set \`model\` to one of: ${names}`
    )
  const router = props.value.role === "router"
  return Promise.all(
    (wanted ?? ids).map(async (id) => {
      const listing = models.value.data.find((model) => model.id === id)
      if (listing === undefined)
        throw new DiscoveryError(`Model is not on the llama.cpp server: ${id} (it lists: ${names})`)
      // A router has no model of its own: each model's facts come from its
      // child, asked by name. A single-model server answers for its one model.
      if (!router) return llamaModel(id, props.value, undefined)
      const own = await getJson(
        input,
        `${root}/props?model=${encodeURIComponent(id)}&autoload=false`
      )
      const loaded = decodeProps(own.body)
      if (own.status === 200 && Option.isSome(loaded))
        return llamaModel(id, loaded.value, undefined)
      // A listed model the router answers 400 for is not loaded ("model is
      // not loaded"): its window is the `--ctx-size` the router will start
      // its child with.
      if (own.status === 400)
        return llamaModel(id, undefined, ctxSizeArgument(listing.status?.args ?? []))
      throw new DiscoveryError(`${root}/props for ${id} answered HTTP ${own.status}`)
    })
  )
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
    throw new DiscoveryError(`${input.baseUrl}/models did not list models (HTTP ${listed.status})`)
  return wanted.map((id) => {
    // Each entry is decoded alone, so one odd entry elsewhere in a list of
    // hundreds cannot fail every model.
    const entry = list.value.data.find((item) => Option.isSome(decodeEntryId(item, id)))
    const model = entry === undefined ? Option.none() : decodeOpenRouterModel(entry)
    if (Option.isNone(model)) throw new DiscoveryError(`Model is not on OpenRouter: ${id}`)
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
    throw new DiscoveryError(
      `The chat template of ${id} has no tool calls, and every Arden request declares tools`
    )
  // `n_ctx` is the window one request gets (per slot), never `n_ctx_train`.
  // On b12359 a router child started with `--ctx-size 4096` and 4 slots
  // reports `n_ctx: 4096`: slots share one unified KV cache, so the
  // `--ctx-size` fallback for an unloaded model is the same number.
  const contextLimit = positive(props?.default_generation_settings?.n_ctx) ?? positive(ctxSize)
  // An unloaded model's template is unknown until it loads, so whatever its
  // `/props` would say is taken as absent: no reasoning effort, no images,
  // one tool call at a time. Loading it first lifts these at the next start.
  const efforts =
    caps?.supports_reasoning_effort === true ? (caps.reasoning_effort_levels ?? []) : []
  return {
    id,
    contextLimit,
    reasoningEfforts: efforts,
    compat: {
      // llama.cpp honors both fields (checked on b12359); `max_tokens` is its
      // long-standing alias of `n_predict`.
      maxTokensField: "max_tokens",
      systemRole: "system",
      reasoningEffort: efforts.length > 0 ? "reasoning_effort" : "none",
      // Checked on b12359: the last chunk carries `usage` with `include_usage`.
      usageInStream: true,
      // The server turns `response_format: json_schema` into a grammar.
      structuredOutput: "json_schema",
      imageInput: props?.modalities?.vision === true,
      parallelToolCalls: caps?.supports_parallel_tool_calls === true,
      cacheControl: "none"
    }
  }
}

const openRouterModel = (model: typeof OpenRouterModelSchema.Type): DiscoveredModel => {
  const parameters = model.supported_parameters ?? []
  if (!parameters.includes("tools"))
    throw new DiscoveryError(
      `OpenRouter lists no tool calls for ${model.id}, and every Arden request declares tools`
    )
  const reasoning = parameters.includes("reasoning")
  return {
    id: model.id,
    // The model's window, or its main provider's when that one is smaller:
    // OpenRouter routes to that provider first.
    contextLimit: smallest([model.context_length, model.top_provider?.context_length]),
    // Without `supported_efforts` the model reasons at its own default and
    // offers no choice, rather than a guessed list.
    reasoningEfforts: reasoning ? (model.reasoning?.supported_efforts ?? []) : [],
    compat: {
      // 450 of 467 models list `max_tokens`, 91 `max_completion_tokens`
      // (listing of 2026-11-15); the docs give both one meaning.
      maxTokensField:
        parameters.includes("max_tokens") || !parameters.includes("max_completion_tokens")
          ? "max_tokens"
          : "max_completion_tokens",
      systemRole: "system",
      reasoningEffort: reasoning ? "openrouter" : "none",
      // https://openrouter.ai/docs/guides/guides/usage-accounting: usage is
      // always in the last chunk.
      usageInStream: true,
      // `structured_outputs` is json_schema support; `response_format` alone
      // may be JSON mode only.
      structuredOutput: parameters.includes("structured_outputs") ? "json_schema" : "none",
      imageInput: model.architecture?.input_modalities?.includes("image") === true,
      parallelToolCalls: parameters.includes("parallel_tool_calls"),
      // Anthropic models cache only at explicit `cache_control` breakpoints
      // (https://openrouter.ai/docs/guides/best-practices/prompt-caching).
      cacheControl: model.id.startsWith("anthropic/") ? "anthropic" : "none"
    }
  }
}

/**
 * Where llama-server serves `/props`: beside `/v1`, so `baseUrl` without its
 * trailing `/v1`. That is the origin, or the origin plus `--api-prefix`.
 */
const serverRoot = (baseUrl: string): string => baseUrl.replace(/\/v1$/, "")

/** The `--ctx-size` value in a router child's arguments, as `/v1/models` lists them. */
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
    throw new DiscoveryError(`Cannot reach ${url}: ${errorMessage(cause)}`, { cause })
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

const decodeLlamaModels = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: Schema.optionalKey(
          Schema.Struct({ args: Schema.optionalKey(Schema.Array(Schema.String)) })
        )
      })
    )
  })
)

const decodeList = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))

const decodeEntryId = (item: unknown, id: string) =>
  Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Literal(id) }))(item)

const OpenRouterModelSchema = Schema.Struct({
  id: Schema.String,
  context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  top_provider: Schema.optionalKey(
    Schema.Struct({ context_length: Schema.optionalKey(Schema.NullOr(Schema.Number)) })
  ),
  supported_parameters: Schema.optionalKey(Schema.Array(Schema.String)),
  architecture: Schema.optionalKey(
    Schema.Struct({ input_modalities: Schema.optionalKey(Schema.Array(Schema.String)) })
  ),
  reasoning: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ supported_efforts: Schema.optionalKey(Schema.Array(Schema.String)) })
    )
  )
})
const decodeOpenRouterModel = Schema.decodeUnknownOption(OpenRouterModelSchema)
