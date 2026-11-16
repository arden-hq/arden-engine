/**
 * Output limits: the one place the server decides how many tokens a model
 * request may write, for a chat step (`chatStepOutputLimit`) and for a side
 * call (the rest of this file).
 *
 * Side calls are model requests the server makes for itself outside a chat
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
import type { ModelDefinition } from "./host.js"

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
 * Never more than the model's `outputCap`. OpenRouter clamps a larger limit
 * rather than refusing it: `max_tokens: 500000` was answered normally by
 * GPT-6 Luna (cap 128,000), Claude Haiku 5.5 (128,000) and DeepSeek V4.1
 * Flash 1017 (384,000) on 2026-11-16. The cap is
 * still applied here so the limit Arden sends is the limit the model works
 * under, on any server, not one a router silently lowers.
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

/**
 * The most one chat step may write, on a route that sends the limit: the
 * room the model's window leaves above its compaction trigger, and never
 * more than the model's own `outputCap`. Undefined on a route that sends
 * none (Codex refuses the field), so its wire stays as it was.
 *
 * Why a limit at all: without one llama.cpp writes until the window is full
 * (`n_predict` defaults to -1; b12359 answers `finish_reason: "length"` at
 * prompt + output = `n_ctx`, checked 2026-11-16), and Gemma 4 E2B on a 32k
 * window thought for 13,000 and 20,000+ tokens before one answer. Why this
 * room: compaction keeps a step's prompt under the trigger, so a step that
 * writes no more than the rest of the window cannot overflow it by its own
 * output, and on a small window the room still holds a long answer (6,554
 * tokens at 32,768). A step cut off at the limit ends with `length`, and the
 * loop asks the model to continue in smaller steps (`policy.ts`
 * `appendOutputLimitContinuation`), twice at most before the run stops with
 * `max_output_length`.
 */
export const chatStepOutputLimit = ({
  context,
  delivery
}: {
  readonly context: ModelDefinition["context"]
  readonly delivery: OutputLimitDelivery
}): number | undefined => {
  if (delivery === "omitted") return undefined
  const room = context.hardLimit - context.compactionTrigger
  // A definition may set its trigger at the window itself (`host.ts` allows
  // it); that leaves no room to size a step by, so only the model's own cap,
  // if any, applies.
  if (room < 1) return context.outputCap
  return Math.min(room, context.outputCap ?? Number.POSITIVE_INFINITY)
}
