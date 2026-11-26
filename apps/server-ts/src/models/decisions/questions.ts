import type { JsonValue } from "@arden-hq/protocol"
import { Effect, Schema } from "effect"

import type { ModelCallUsage } from "../../persistence/usage/store.js"
import type { CompletionImage } from "../structured-completion.js"

export const DECISION_KIND = {
  predicate: "predicate",
  choice: "choice",
  score: "score",
  box: "box"
} as const

const DECISION_PREDICATE = { yes: "true", no: "false" } as const
const isYes = (value: string): value is typeof DECISION_PREDICATE.yes =>
  value === DECISION_PREDICATE.yes

export const DECISION_FALLBACK = { helper: "helper", none: "none" } as const

export const DECISION_DISTRIBUTION = {
  calibrated: "calibrated",
  selectedOnly: "selected-only"
} as const

export const DECISIONS_ERROR_REASON = {
  invalidRequest: "invalid_request",
  unavailable: "unavailable",
  provider: "provider",
  invalidOutput: "invalid_output",
  refused: "refused"
} as const

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
  readonly kind: typeof DECISION_KIND.predicate
}

interface ChoiceQuestion extends QuestionBase {
  readonly kind: typeof DECISION_KIND.choice
  readonly options: readonly [DecisionOption, ...ReadonlyArray<DecisionOption>]
}

interface ScoreQuestion extends QuestionBase {
  readonly kind: typeof DECISION_KIND.score
  readonly levels: readonly [DecisionOption, ...ReadonlyArray<DecisionOption>]
}

interface BoxQuestion extends QuestionBase {
  readonly kind: typeof DECISION_KIND.box
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
  readonly fallback?: typeof DECISION_FALLBACK.helper | typeof DECISION_FALLBACK.none
  readonly signal?: AbortSignal
}

type DecisionDistribution =
  | {
      readonly kind: typeof DECISION_DISTRIBUTION.calibrated
      readonly probabilities: Readonly<Record<string, number>>
      readonly confidence: number
    }
  | {
      readonly kind: typeof DECISION_DISTRIBUTION.selectedOnly
      readonly probabilities: Readonly<Record<string, number>>
    }

interface PredicateAnswer {
  readonly kind: typeof DECISION_KIND.predicate
  readonly value: boolean
  readonly distribution: DecisionDistribution
}

interface ChoiceAnswer {
  readonly kind: typeof DECISION_KIND.choice
  readonly value: string
  readonly distribution: DecisionDistribution
}

interface ScoreAnswer {
  readonly kind: typeof DECISION_KIND.score
  readonly value: string
  readonly level: number
  readonly distribution: DecisionDistribution
}

interface BoxAnswer {
  readonly kind: typeof DECISION_KIND.box
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
  reason: Schema.Literals(Object.values(DECISIONS_ERROR_REASON)),
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
    case DECISION_KIND.predicate:
    case DECISION_KIND.box:
      return []
    case DECISION_KIND.choice:
      return question.options
    case DECISION_KIND.score:
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
      question.kind === DECISION_KIND.box &&
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
    case DECISION_KIND.predicate:
    case DECISION_KIND.box:
      return undefined
    case DECISION_KIND.choice:
      return question.options.length < 2 || question.options.length > CHOICE_MAX_OPTIONS
        ? `needs 2 to ${CHOICE_MAX_OPTIONS} options`
        : undefined
    case DECISION_KIND.score:
      return question.levels.length < 2 || question.levels.length > SCORE_MAX_LEVELS
        ? `needs 2 to ${SCORE_MAX_LEVELS} levels`
        : undefined
  }
}

const invalidRequest = (message: string): DecisionsError =>
  new DecisionsError({ reason: DECISIONS_ERROR_REASON.invalidRequest, message })

export const invalidOutput = (message: string): DecisionsError =>
  new DecisionsError({ reason: DECISIONS_ERROR_REASON.invalidOutput, message })

export const calibratedAnswer = (
  question: ScalarDecisionQuestion,
  scores: {
    readonly probabilities: Readonly<Record<string, number>>
    readonly picked: string | undefined
    readonly confidence: number | undefined
  }
): DecisionAnswer | undefined => {
  const values =
    question.kind === DECISION_KIND.predicate
      ? [DECISION_PREDICATE.yes, DECISION_PREDICATE.no]
      : optionsOf(question).map((o) => o.value)
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
    kind: DECISION_DISTRIBUTION.calibrated,
    probabilities,
    confidence: scores.confidence ?? probabilities[top] ?? 0
  }
  switch (question.kind) {
    case DECISION_KIND.predicate:
      return { kind: DECISION_KIND.predicate, value: isYes(value), distribution }
    case DECISION_KIND.choice:
      return { kind: DECISION_KIND.choice, value, distribution }
    case DECISION_KIND.score:
      return { kind: DECISION_KIND.score, value, level: values.indexOf(value), distribution }
  }
}
