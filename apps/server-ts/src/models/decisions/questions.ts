import type { JsonValue } from "@arden-hq/protocol"
import { Effect, Schema } from "effect"

import type { ModelCallUsage } from "../../persistence/usage/store.js"
import type { CompletionImage } from "../structured-completion.js"

/**
 * The question kinds both decision wire formats share: OpenAI `/v1/decisions`
 * calls them predicate / choice / score, TypeSafe `/v1/systemone` calls them
 * noul / choice / score. Limits are the stricter of the two: a choice holds
 * 2–255 options, a score 2–10 levels ordered lowest first.
 */
export const CHOICE_MAX_OPTIONS = 255
const SCORE_MAX_LEVELS = 10

export interface DecisionOption {
  readonly value: string
  readonly description: string
}

interface QuestionBase {
  readonly instructions: string
}

interface PredicateQuestion extends QuestionBase {
  readonly kind: "predicate"
}

interface ChoiceQuestion extends QuestionBase {
  readonly kind: "choice"
  readonly options: readonly [DecisionOption, ...ReadonlyArray<DecisionOption>]
}

interface ScoreQuestion extends QuestionBase {
  readonly kind: "score"
  readonly levels: readonly [DecisionOption, ...ReadonlyArray<DecisionOption>]
}

interface BoxQuestion extends QuestionBase {
  readonly kind: "box"
  readonly image: number
}

export type ScalarDecisionQuestion = PredicateQuestion | ChoiceQuestion | ScoreQuestion
export type DecisionQuestion = ScalarDecisionQuestion | BoxQuestion

interface DecisionBox {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

export type DecisionInputKind = "text" | "text+image"

export interface DecisionInput {
  readonly instructions: string
  readonly state: JsonValue
  readonly images: ReadonlyArray<CompletionImage>
  readonly questions: Readonly<Record<string, DecisionQuestion>>
  readonly usage: ModelCallUsage
  readonly fallback?: "helper" | "none"
  readonly signal?: AbortSignal
}

type DecisionDistribution =
  | {
      readonly kind: "calibrated"
      readonly probabilities: Readonly<Record<string, number>>
      readonly confidence: number
    }
  | { readonly kind: "selected-only"; readonly probabilities: Readonly<Record<string, number>> }

interface PredicateAnswer {
  readonly kind: "predicate"
  readonly value: boolean
  readonly distribution: DecisionDistribution
}

interface ChoiceAnswer {
  readonly kind: "choice"
  readonly value: string
  readonly distribution: DecisionDistribution
}

interface ScoreAnswer {
  readonly kind: "score"
  readonly value: string
  readonly level: number
  readonly distribution: DecisionDistribution
}

interface BoxAnswer {
  readonly kind: "box"
  readonly image: number
  readonly box: DecisionBox
  readonly confidence: number
}

export type DecisionAnswer = PredicateAnswer | ChoiceAnswer | ScoreAnswer | BoxAnswer

type DecisionBackendId = "llm" | (string & {})

export interface DecisionResult {
  readonly backend: DecisionBackendId
  readonly answers: Readonly<Record<string, DecisionAnswer>>
}

export class DecisionsError extends Schema.TaggedError<DecisionsError>()("DecisionsError", {
  reason: Schema.Literals([
    "invalid_request",
    "unavailable",
    "provider",
    "invalid_output",
    "refused"
  ] as const),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export interface DecisionBackend {
  readonly id: DecisionBackendId
  readonly input: DecisionInputKind
  readonly classify: (input: DecisionInput) => Effect.Effect<DecisionResult, DecisionsError>
}

export const optionsOf = (question: DecisionQuestion): ReadonlyArray<DecisionOption> => {
  switch (question.kind) {
    case "predicate":
    case "box":
      return []
    case "choice":
      return question.options
    case "score":
      return question.levels
  }
}

export const validateDecisionInput = Effect.fn("Decisions.validateInput")(function* (
  input: DecisionInput
) {
  if (input.instructions.trim().length === 0) {
    return yield* invalidRequest("Decision instructions cannot be empty")
  }
  const entries = Object.entries(input.questions)
  if (entries.length === 0)
    return yield* invalidRequest("At least one decision question is required")
  for (const [name, question] of entries) {
    if (name.trim().length === 0)
      return yield* invalidRequest("Decision question names cannot be empty")
    if (question.instructions.trim().length === 0) {
      return yield* invalidRequest(`Decision question ${name} has empty instructions`)
    }
    if (
      question.kind === "box" &&
      (!Number.isInteger(question.image) ||
        question.image < 0 ||
        question.image >= input.images.length)
    ) {
      return yield* invalidRequest(`Decision question ${name} must name an attached image`)
    }
    const values = optionsOf(question).map((option) => option.value)
    if (values.some((value) => value.trim().length === 0)) {
      return yield* invalidRequest(`Decision question ${name} has an empty option`)
    }
    if (new Set(values).size !== values.length) {
      return yield* invalidRequest(`Decision question ${name} has duplicate options`)
    }
    const problem = sizeProblem(question)
    if (problem !== undefined) return yield* invalidRequest(`Decision question ${name} ${problem}`)
  }
})

const sizeProblem = (question: DecisionQuestion): string | undefined => {
  switch (question.kind) {
    case "predicate":
    case "box":
      return undefined
    case "choice":
      return question.options.length < 2 || question.options.length > CHOICE_MAX_OPTIONS
        ? `needs 2 to ${CHOICE_MAX_OPTIONS} options`
        : undefined
    case "score":
      return question.levels.length < 2 || question.levels.length > SCORE_MAX_LEVELS
        ? `needs 2 to ${SCORE_MAX_LEVELS} levels`
        : undefined
  }
}

const invalidRequest = (message: string): DecisionsError =>
  new DecisionsError({ reason: "invalid_request", message })

export const invalidOutput = (message: string): DecisionsError =>
  new DecisionsError({ reason: "invalid_output", message })

export const calibratedAnswer = (
  question: ScalarDecisionQuestion,
  scores: {
    readonly probabilities: Readonly<Record<string, number>>
    readonly picked: string | undefined
    readonly confidence: number | undefined
  }
): DecisionAnswer | undefined => {
  const values =
    question.kind === "predicate" ? ["true", "false"] : optionsOf(question).map((o) => o.value)
  if (Object.keys(scores.probabilities).some((key) => !values.includes(key))) return undefined
  if (scores.picked !== undefined && !values.includes(scores.picked)) return undefined
  const probabilities = Object.fromEntries(
    values.map((value) => [value, scores.probabilities[value] ?? 0])
  )
  const top = values.reduce((best, value) =>
    (probabilities[value] ?? 0) > (probabilities[best] ?? 0) ? value : best
  )
  const value = scores.picked ?? top
  const distribution = {
    kind: "calibrated" as const,
    probabilities,
    confidence: scores.confidence ?? probabilities[top] ?? 0
  }
  switch (question.kind) {
    case "predicate":
      return { kind: "predicate", value: value === "true", distribution }
    case "choice":
      return { kind: "choice", value, distribution }
    case "score":
      return { kind: "score", value, level: values.indexOf(value), distribution }
  }
}
