/**
 * Side calls: model requests the server makes for itself outside a chat
 * run — chat names, task descriptions, reviews, triage, rule compiles,
 * compaction summaries. Each names a budget of visible answer tokens, but
 * every wire counts thinking against the output limit (OpenAI and
 * OpenRouter `max_tokens`/`max_output_tokens`, llama.cpp `n_predict`): Gemma
 * 4 E2B on llama.cpp b12359 spent an 80-token chat-name budget on thinking
 * and wrote no name. These functions are the one place a side call's
 * effort and output limit are chosen; `StructuredCompletion` and the
 * compaction summarizer use nothing else.
 */

import type { ModelCapabilities } from "@arden-hq/loop"

/**
 * The effort that turns thinking off wherever a model declares it: OpenAI
 * `reasoning.effort`, OpenRouter `reasoning: { effort: "none" }` (its model
 * list leaves `none` out where reasoning is mandatory), and llama.cpp
 * `reasoning_effort`, which the server maps to `enable_thinking: false` for
 * any template (b12359 `server-common.cpp`; checked live on Gemma 4).
 */
const THINKING_OFF = "none"

/**
 * Room for thinking on top of the answer budget, when a call may think.
 * Gemma 4 E2B thought 321–532 tokens before a three-word chat name
 * (2026-11-16); OpenRouter gives an OpenAI model at `medium` about half of
 * the limit to reasoning. A model stops when it is done, so the room costs
 * only what it uses.
 */
export const REASONING_ALLOWANCE_TOKENS = 4_096

/** Whether a route sends the output limit at all (`ModelCapabilities.outputLimit`). */
export type OutputLimitDelivery = NonNullable<ModelCapabilities["outputLimit"]>

export const outputLimitDelivery = (capabilities: ModelCapabilities): OutputLimitDelivery =>
  capabilities.outputLimit ?? "sent"

/**
 * The effort a one-answer side call runs at: the assignment's when it names
 * one (a person chose it, or the model list's default for that model);
 * otherwise thinking off when the model declares the switch and the route
 * sends the output limit, the only reason to turn it off; otherwise the
 * model's default (undefined). A route that never sends the limit (Codex)
 * cannot have an answer cut short by thinking, so it keeps the default it
 * had before side calls chose efforts. A multi-step worker and a compaction
 * summary keep their assigned effort instead: a worker is an agent run, and
 * the summary replays the chat's cached prefix, which llama.cpp renders with
 * the effort's thinking switch.
 */
export const sideCallEffort = ({
  assigned,
  declared,
  delivery
}: {
  readonly assigned: string | undefined
  /** The model's `ModelDefinition.reasoningEfforts`. */
  readonly declared: ReadonlyArray<string>
  readonly delivery: OutputLimitDelivery
}): string | undefined =>
  assigned ?? (delivery === "sent" && declared.includes(THINKING_OFF) ? THINKING_OFF : undefined)

/**
 * The output limit to send for `answerTokens` of visible answer at
 * `effort`. Only `none` is known not to think; any other effort, or the
 * model's default (undefined), gets `REASONING_ALLOWANCE_TOKENS` on top.
 * That includes models that declare no effort at all: OpenRouter lists
 * models whose reasoning is mandatory without any effort, and a `generic`
 * server may run a thinking model the settings say nothing about.
 *
 * Never more than the model's `outputCap`. OpenRouter documents only that
 * the limit's maximum is "the context length minus the prompt length"
 * (https://openrouter.ai/docs/api-reference/parameters), not whether a
 * limit over a model's `max_completion_tokens` is clamped or refused, so
 * the server is not asked for more than the model writes.
 */
export const sideCallOutputLimit = ({
  answerTokens,
  effort,
  outputCap
}: {
  readonly answerTokens: number
  readonly effort: string | undefined
  /** The model's `ModelDefinition.context.outputCap`. */
  readonly outputCap: number | undefined
}): number =>
  Math.min(
    effort === THINKING_OFF ? answerTokens : answerTokens + REASONING_ALLOWANCE_TOKENS,
    outputCap ?? Number.POSITIVE_INFINITY
  )
