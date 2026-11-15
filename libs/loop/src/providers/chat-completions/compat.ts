/**
 * The wire differences between Chat Completions servers, as one flag block
 * resolved once against the defaults. The adapter reads only these flags;
 * it never branches on who serves the route. A flag exists only when a
 * target server needs it and the need was verified against that server or
 * the reference adapters (prime `openai_completions`, hermes `chat_completions`).
 */
export interface ChatCompletionsCompat {
  /**
   * The output-token limit field. `max_completion_tokens` is OpenAI's current
   * name (its reasoning models refuse `max_tokens`) and OpenRouter accepts it;
   * llama.cpp reads both; `max_tokens` is for older OpenAI-compatible servers.
   */
  readonly maxTokensField: "max_completion_tokens" | "max_tokens"
  /**
   * The role every system and developer message is sent with. One role per
   * route: OpenAI's reasoning models take `developer` and treat `system` the
   * same, while generic servers (vLLM, Ollama) know only `system`.
   */
  readonly systemRole: "system" | "developer"
  /**
   * How the request's reasoning effort is sent: top-level `reasoning_effort`
   * (OpenAI, and llama.cpp, which turns thinking off for `none` with any
   * template and hands other values to the template), OpenRouter's
   * `reasoning: { effort }`, or not at all for a route without an effort
   * setting.
   */
  readonly reasoningEffort: "reasoning_effort" | "openrouter" | "none"
  /**
   * Ask for the usage chunk with `stream_options: { include_usage: true }`.
   * OpenAI, OpenRouter and llama.cpp send usage only when asked; a server
   * that refuses unknown fields can turn it off.
   */
  readonly usageInStream: boolean
  /**
   * `json_schema` sends structured output as `response_format: { type:
   * "json_schema", json_schema: { name, schema, strict: true } }` (OpenAI,
   * OpenRouter, llama.cpp grammar-constrains it) and declares
   * `structuredOutput: "native"`; `none` declares the route cannot, so the
   * loop refuses a run with `output` before inference.
   */
  readonly structuredOutput: "json_schema" | "none"
  /**
   * The route accepts `image_url` parts (a vision model, or llama.cpp with a
   * multimodal projector). Without it an image block is an error, never
   * dropped: the model would answer about an image it never saw.
   */
  readonly imageInput: boolean
  /**
   * Send `parallel_tool_calls: true`. llama.cpp generates one call per turn
   * unless asked; OpenAI and OpenRouter default to parallel already.
   */
  readonly parallelToolCalls: boolean
  /**
   * `anthropic` marks Anthropic-syntax prompt-cache breakpoints
   * (`cache_control: { type: "ephemeral" }`) on the last tool, the first
   * system message and the last conversation message, as prime
   * `apply_anthropic_cache_control` sends them. The value names the syntax,
   * not the vendor: OpenRouter takes it for Claude and for Alibaba's Qwen
   * models, which cache only at these breakpoints (which models, from the
   * OpenRouter docs: server-ts `discovery.ts` `EXPLICIT_CACHE`). Other
   * servers cache by prefix on their own.
   */
  readonly cacheControl: "anthropic" | "none"
}

export const DEFAULT_COMPAT: ChatCompletionsCompat = Object.freeze({
  maxTokensField: "max_completion_tokens",
  systemRole: "system",
  reasoningEffort: "none",
  usageInStream: true,
  structuredOutput: "none",
  imageInput: false,
  parallelToolCalls: false,
  cacheControl: "none"
})

/** The top-level body keys this compat can write; `extraBody` may not set them. */
export const ownedBodyKeys = (compat: ChatCompletionsCompat): ReadonlyArray<string> => [
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  compat.maxTokensField,
  ...(compat.reasoningEffort === "reasoning_effort" ? ["reasoning_effort"] : []),
  ...(compat.reasoningEffort === "openrouter" ? ["reasoning"] : [])
]
