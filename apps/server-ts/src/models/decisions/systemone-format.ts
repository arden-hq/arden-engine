import { Effect, Schema } from "effect"

import { type DecisionEndpoint, postDecisionRequest } from "./endpoint.js"
import { fitJevImage } from "./image-fit.js"
import {
  calibratedAnswer,
  type DecisionAnswer,
  type DecisionBackend,
  type DecisionInput,
  type DecisionQuestion,
  invalidOutput,
  DecisionsError,
  validateDecisionInput
} from "./questions.js"

export const systemOneFormatBackend = (endpoint: DecisionEndpoint): DecisionBackend => ({
  id: endpoint.id,
  input: endpoint.input,
  classify: Effect.fn("Decisions.systemone")(function* (input: DecisionInput) {
    yield* validateDecisionInput(input)
    if (input.images.length > 0 && endpoint.input === "text") {
      return yield* new DecisionsError({
        reason: "invalid_request",
        message: "This endpoint has not passed the image check"
      })
    }
    if (
      endpoint.format === "llama-systemone" &&
      Object.values(input.questions).some((q) => q.kind === "box")
    ) {
      return yield* new DecisionsError({
        reason: "invalid_request",
        message: "The local decision transport does not support boxes"
      })
    }
    if (
      endpoint.format !== "llama-systemone" &&
      input.images.some((image) => !["image/png", "image/jpeg"].includes(image.mediaType))
    ) {
      return yield* new DecisionsError({
        reason: "invalid_request",
        message: "Jev images must be PNG or JPEG"
      })
    }
    const images =
      endpoint.format === "llama-systemone"
        ? input.images
        : yield* Effect.forEach(input.images, (image) => fitJevImage(image, input.signal))
    const body = yield* postDecisionRequest(endpoint, {
      body: systemOneRequest(endpoint, { ...input, images }),
      ...(endpoint.format === "systemone" && input.images.length > 0
        ? { headers: { "TypeSafe-Danger-Zone-Images": "true" } }
        : {}),
      signal: input.signal
    })
    return { backend: endpoint.id, answers: yield* systemOneAnswers(input.questions, body) }
  })
})

const systemOneRequest = (endpoint: DecisionEndpoint, input: DecisionInput) => ({
  model: endpoint.model,
  ...systemOneState(endpoint, input),
  questions: Object.fromEntries(
    Object.entries(input.questions).map(([name, question]) => [
      name,
      systemOneQuestion(question, endpoint.format)
    ])
  )
})

const systemOneState = (endpoint: DecisionEndpoint, input: DecisionInput) => {
  const state = { task: input.instructions, state: input.state }
  if (input.images.length === 0) return { state }
  switch (endpoint.format) {
    case "systemone": {
      const refs = input.images.map(() => crypto.randomUUID())
      return {
        state: { ...state, images: refs },
        assets: Object.fromEntries(
          input.images.map((image, index) => [
            refs[index],
            {
              type: "image",
              format: image.mediaType === "image/png" ? "png" : "jpg",
              data_base64: image.data
            }
          ])
        )
      }
    }
    case "openrouter-decisions":
      return {
        state: [
          state,
          ...input.images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${image.data}` }
          }))
        ]
      }
    case "llama-systemone":
      return {
        state,
        images: input.images.map((image) => `data:${image.mediaType};base64,${image.data}`)
      }
    case "decisions":
      return { state }
  }
}

const systemOneQuestion = (question: DecisionQuestion, format: DecisionEndpoint["format"]) => {
  switch (question.kind) {
    case "box":
      return {
        type: "box",
        instructions: `${question.instructions} in \`${format === "systemone" ? `images[${question.image}]` : `[${question.image + 1}]`}\`.`
      }
    case "predicate":
      return { type: "noul", instructions: question.instructions }
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: Object.fromEntries(
          question.options.map((option) => [option.value, option.description])
        )
      }
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        criteria: question.levels.map((level) =>
          level.description.length === 0 ? level.value : `${level.value}: ${level.description}`
        )
      }
  }
}

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const BoxSchema = Schema.Struct({
  top: Probability,
  bottom: Probability,
  left: Probability,
  right: Probability
}).check(
  Schema.makeFilter(
    (box) => (box.top < box.bottom && box.left < box.right) || "Box edges must be ordered"
  )
)

const SystemOneAnswerSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("box"), box: BoxSchema, confidence: Probability }),
  Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    confidence: Probability,
    probabilities: Schema.Record(Schema.String, Probability)
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    confidence: Probability,
    probabilities: Schema.Record(Schema.String, Probability)
  })
])

const SystemOneResponseSchema = Schema.Struct({
  answers: Schema.Record(Schema.String, SystemOneAnswerSchema)
})

const systemOneAnswers = Effect.fn("Decisions.systemOneAnswers")(function* (
  questions: Readonly<Record<string, DecisionQuestion>>,
  body: unknown
) {
  const response = yield* Schema.decodeUnknownEffect(SystemOneResponseSchema)(body).pipe(
    Effect.mapError(() => invalidOutput("The System One response has an unexpected shape"))
  )
  if (Object.keys(response.answers).length !== Object.keys(questions).length) {
    return yield* invalidOutput("The System One response does not match the asked questions")
  }
  const answers: Record<string, DecisionAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const raw = response.answers[name]
    const answer = raw === undefined ? undefined : systemOneAnswer(question, raw)
    if (answer === undefined) {
      return yield* invalidOutput(`The System One answer for ${name} does not fit its question`)
    }
    answers[name] = answer
  }
  return answers
})

const systemOneAnswer = (
  question: DecisionQuestion,
  raw: typeof SystemOneAnswerSchema.Type
): DecisionAnswer | undefined => {
  switch (raw.type) {
    case "box":
      return question.kind === "box"
        ? { kind: "box", image: question.image, box: raw.box, confidence: raw.confidence }
        : undefined
    case "noul":
      return question.kind === "predicate"
        ? calibratedAnswer(question, {
            probabilities: { true: raw.noul, false: 1 - raw.noul },
            picked: undefined,
            confidence: undefined
          })
        : undefined
    case "choice":
      return question.kind === "choice"
        ? calibratedAnswer(question, {
            probabilities: raw.probabilities,
            picked: raw.choice,
            confidence: raw.confidence
          })
        : undefined
    case "score": {
      if (question.kind !== "score") return undefined
      const byLevel = Object.entries(raw.probabilities).map(([index, probability]) => {
        const level = question.levels[Number(index)]
        return level === undefined ? undefined : ([level.value, probability] as const)
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
