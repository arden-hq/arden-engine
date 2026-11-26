import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Schema } from "effect"

import { type DecisionEndpoint, postDecisionRequest } from "./endpoint.js"
import {
  calibratedAnswer,
  DECISION_KIND,
  type DecisionAnswer,
  type DecisionBackend,
  type DecisionInput,
  type DecisionQuestion,
  DecisionsError,
  invalidOutput,
  validateDecisionInput
} from "./questions.js"
import { stateText } from "./state-text.js"

export const decisionsFormatBackend = (endpoint: DecisionEndpoint): DecisionBackend => ({
  id: endpoint.id,
  input: endpoint.input,
  classify: Effect.fn("Decisions.decisionsFormat")(function* (input: DecisionInput) {
    yield* validateDecisionInput(input)
    if (Object.values(input.questions).some((question) => question.kind === DECISION_KIND.box)) {
      return yield* new DecisionsError({
        reason: "invalid_request",
        message: "This decision backend does not support boxes"
      })
    }
    const body = yield* postDecisionRequest(endpoint, {
      body: decisionsRequest(endpoint.model, input),
      signal: input.signal
    })
    return { backend: endpoint.id, answers: yield* decisionsAnswers(input.questions, body) }
  })
})

const decisionsRequest = (model: string, input: DecisionInput) => ({
  model,
  input: [
    {
      role: ROLE.user,
      content: [
        { type: "input_text", text: stateText(input) },
        ...input.images.map((image) => ({
          type: "input_image",
          image_url: `data:${image.mediaType};base64,${image.data}`
        }))
      ]
    }
  ],
  questions: Object.entries(input.questions).map(([name, question]) =>
    decisionsQuestion(name, question)
  )
})

const DECISIONS_ANSWER = {
  predicate: "predicate",
  choice: "choice",
  score: "score",
  refusal: "refusal"
} as const

const decisionsQuestion = (name: string, question: DecisionQuestion) => {
  switch (question.kind) {
    case DECISION_KIND.box:
      return undefined
    case DECISION_KIND.predicate:
      return { type: "predicate", name, instructions: question.instructions }
    case DECISION_KIND.choice:
      return {
        type: "choice",
        name,
        instructions: question.instructions,
        choices: question.options
      }
    case DECISION_KIND.score:
      return {
        type: "score",
        name,
        instructions: question.instructions,
        levels: question.levels.map((level) => ({
          label: level.value,
          description: level.description
        }))
      }
  }
}

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const DecisionsAnswerSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal(DECISIONS_ANSWER.predicate),
    name: Schema.String,
    probability: Probability
  }),
  Schema.Struct({
    type: Schema.Literal(DECISIONS_ANSWER.choice),
    name: Schema.String,
    choice: Schema.String,
    probabilities: Schema.Array(Schema.Struct({ value: Schema.String, probability: Probability })),
    confidence: Probability
  }),
  Schema.Struct({
    type: Schema.Literal(DECISIONS_ANSWER.score),
    name: Schema.String,
    score: Schema.Number,
    probabilities: Schema.Array(
      Schema.Struct({ value: Schema.Number, label: Schema.String, probability: Probability })
    ),
    confidence: Probability
  }),
  Schema.Struct({ type: Schema.Literal(DECISIONS_ANSWER.refusal), name: Schema.String })
])

const DecisionsResponseSchema = Schema.Struct({ answers: Schema.Array(DecisionsAnswerSchema) })

const decisionsAnswers = Effect.fn("Decisions.decisionsAnswers")(function* (
  questions: Readonly<Record<string, DecisionQuestion>>,
  body: unknown
) {
  const response = yield* Schema.decodeUnknownEffect(DecisionsResponseSchema)(body).pipe(
    Effect.mapError(() => invalidOutput("The Decisions response has an unexpected shape"))
  )
  const byName = new Map(response.answers.map((answer) => [answer.name, answer]))
  const answers: Record<string, DecisionAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const raw = byName.get(name)
    if (raw?.type === DECISIONS_ANSWER.refusal) {
      return yield* new DecisionsError({
        reason: "refused",
        message: `The decision model refused to answer ${name}`
      })
    }
    const answer = raw === undefined ? undefined : decisionsAnswer(question, raw)
    if (answer === undefined) {
      return yield* invalidOutput(`The Decisions answer for ${name} does not fit its question`)
    }
    answers[name] = answer
  }
  return answers
})

const decisionsAnswer = (
  question: DecisionQuestion,
  raw: Exclude<typeof DecisionsAnswerSchema.Type, { type: typeof DECISIONS_ANSWER.refusal }>
): DecisionAnswer | undefined => {
  switch (raw.type) {
    case DECISIONS_ANSWER.predicate:
      return question.kind === DECISION_KIND.predicate
        ? calibratedAnswer(question, {
            probabilities: { true: raw.probability, false: 1 - raw.probability },
            picked: undefined,
            confidence: undefined
          })
        : undefined
    case DECISIONS_ANSWER.choice:
      return question.kind === DECISION_KIND.choice
        ? calibratedAnswer(question, {
            probabilities: Object.fromEntries(
              raw.probabilities.map((entry) => [entry.value, entry.probability])
            ),
            picked: raw.choice,
            confidence: raw.confidence
          })
        : undefined
    case DECISIONS_ANSWER.score: {
      if (question.kind !== DECISION_KIND.score) return undefined
      const byLevel = raw.probabilities.map((entry) => {
        const level = question.levels[entry.value]
        return level === undefined ? undefined : ([level.value, entry.probability] as const)
      })
      if (byLevel.some((entry) => entry === undefined)) return undefined
      return calibratedAnswer(question, {
        probabilities: Object.fromEntries(byLevel.filter((entry) => entry !== undefined)),
        picked: undefined,
        confidence: raw.confidence
      })
    }
  }
}
