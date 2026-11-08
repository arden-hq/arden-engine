import { Effect, Schema } from "effect"

import { type DecisionEndpoint, postDecisionRequest } from "./endpoint.js"
import {
  calibratedAnswer,
  type DecisionAnswer,
  type DecisionBackend,
  type DecisionInput,
  type DecisionQuestion,
  DecisionsError,
  invalidOutput,
  validateDecisionInput
} from "./questions.js"
import { stateText } from "./state-text.js"

/**
 * The Decisions wire format (`POST {base}/v1/decisions`), as OpenAI serves
 * `gpt-6-luna` (public beta since 2026-10-06; an API key, the ChatGPT/Codex
 * sign-in is refused) and gateways route other decision models through it.
 * Images go inline as base64 data URLs. Questions are an array with a `name`
 * each; answers come back as an array under the same names, and a question
 * the model will not answer comes back as `{ type: "refusal", name }`.
 * Shapes: developers.openai.com/api/docs/guides/decisions (checked 2026-10-10).
 */
export const decisionsFormatBackend = (endpoint: DecisionEndpoint): DecisionBackend => ({
  id: endpoint.id,
  input: endpoint.input,
  classify: Effect.fn("Decisions.decisionsFormat")(function* (input: DecisionInput) {
    yield* validateDecisionInput(input)
    if (Object.values(input.questions).some((question) => question.kind === "box")) {
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
      role: "user",
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

const decisionsQuestion = (name: string, question: DecisionQuestion) => {
  switch (question.kind) {
    case "box":
      return undefined
    case "predicate":
      return { type: "predicate", name, instructions: question.instructions }
    case "choice":
      return {
        type: "choice",
        name,
        instructions: question.instructions,
        choices: question.options
      }
    case "score":
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
    type: Schema.Literal("predicate"),
    name: Schema.String,
    probability: Probability
  }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    name: Schema.String,
    choice: Schema.String,
    probabilities: Schema.Array(Schema.Struct({ value: Schema.String, probability: Probability })),
    confidence: Probability
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    name: Schema.String,
    score: Schema.Number,
    probabilities: Schema.Array(
      Schema.Struct({ value: Schema.Number, label: Schema.String, probability: Probability })
    ),
    confidence: Probability
  }),
  Schema.Struct({ type: Schema.Literal("refusal"), name: Schema.String })
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
    if (raw?.type === "refusal") {
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
  raw: Exclude<typeof DecisionsAnswerSchema.Type, { type: "refusal" }>
): DecisionAnswer | undefined => {
  switch (raw.type) {
    case "predicate":
      return question.kind === "predicate"
        ? calibratedAnswer(question, {
            probabilities: { true: raw.probability, false: 1 - raw.probability },
            picked: undefined,
            confidence: undefined
          })
        : undefined
    case "choice":
      return question.kind === "choice"
        ? calibratedAnswer(question, {
            probabilities: Object.fromEntries(
              raw.probabilities.map((entry) => [entry.value, entry.probability])
            ),
            picked: raw.choice,
            confidence: raw.confidence
          })
        : undefined
    case "score": {
      if (question.kind !== "score") return undefined
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
