export const REASONING_EFFORT_STYLE = {
  reasoningEffort: "reasoning_effort",
  openrouter: "openrouter",
  none: "none"
} as const
export type ReasoningEffortStyle =
  (typeof REASONING_EFFORT_STYLE)[keyof typeof REASONING_EFFORT_STYLE]

export const COMPAT_STRUCTURED_OUTPUT = { jsonSchema: "json_schema", none: "none" } as const
export type CompatStructuredOutput =
  (typeof COMPAT_STRUCTURED_OUTPUT)[keyof typeof COMPAT_STRUCTURED_OUTPUT]

export const CACHE_CONTROL_STYLE = { anthropic: "anthropic", none: "none" } as const
export type CacheControlStyle = (typeof CACHE_CONTROL_STYLE)[keyof typeof CACHE_CONTROL_STYLE]

export const TOOL_CHOICE_NONE = { enforced: "enforced", unenforced: "unenforced" } as const
export type ToolChoiceNone = (typeof TOOL_CHOICE_NONE)[keyof typeof TOOL_CHOICE_NONE]

export interface ChatCompletionsCompat {
  readonly maxTokensField: "max_completion_tokens" | "max_tokens"
  readonly systemRole: "system" | "developer"
  readonly reasoningEffort: ReasoningEffortStyle
  readonly usageInStream: boolean
  readonly structuredOutput: CompatStructuredOutput
  readonly imageInput: boolean
  readonly parallelToolCalls: boolean
  readonly cacheControl: CacheControlStyle
  readonly toolChoiceNone: ToolChoiceNone
}

export const DEFAULT_COMPAT: ChatCompletionsCompat = Object.freeze({
  maxTokensField: "max_completion_tokens",
  systemRole: "system",
  reasoningEffort: "none",
  usageInStream: true,
  structuredOutput: "none",
  imageInput: false,
  parallelToolCalls: false,
  cacheControl: "none",
  toolChoiceNone: "enforced"
})

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
  ...(compat.reasoningEffort === REASONING_EFFORT_STYLE.reasoningEffort
    ? ["reasoning_effort"]
    : []),
  ...(compat.reasoningEffort === REASONING_EFFORT_STYLE.openrouter ? ["reasoning"] : [])
]
