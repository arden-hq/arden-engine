import { Effect, Schema } from "effect"

import type { StructuredCompletion, StructuredCompletionError } from "../structured-completion.js"
import {
  type DecisionAnswer,
  type DecisionBackend,
  type DecisionInput,
  type DecisionQuestion,
  DecisionsError,
  invalidOutput,
  validateDecisionInput,
  optionsOf
} from "./questions.js"
import { questionsText, stateMarkdown } from "./state-text.js"

const LLM_SYSTEM = `Read the task and the state, then answer every question exactly once.

Each question is one field of the output, under its name. For a question with listed answers, copy one listed value exactly. For a predicate question, answer true or false. Do not add explanations.`

export const llmDecisionBackend = (
  completion: Pick<StructuredCompletion["Service"], "run">
): DecisionBackend => ({
  id: "llm",
  input: "text+image",
  classify: Effect.fn("Decisions.llm")(function* (input: DecisionInput) {
    yield* validateDecisionInput(input)
    if (Object.values(input.questions).some((question) => question.kind === "box")) {
      return yield* new DecisionsError({
        reason: "invalid_request",
        message: "This decision backend does not support boxes"
      })
    }
    const entries = Object.entries(input.questions)
    const output = yield* completion
      .run({
        role: "helper",
        usage: input.usage,
        system: `${LLM_SYSTEM}\n\n${input.instructions}`,
        user: `${stateMarkdown(input.state)}\n\n${questionsText(input.questions)}`,
        images: input.images,
        output: Schema.Struct(
          Object.fromEntries(entries.map(([name, question]) => [name, answerSchema(question)]))
        ),
        outputName: "decisions",
        maxOutputTokens: Math.min(1_000, 50 + entries.length * 30),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      })
      .pipe(Effect.mapError(completionError))
    return { backend: "llm", answers: yield* selectedAnswers(entries, output) }
  })
})

const selectedAnswers = Effect.fn("Decisions.selectedAnswers")(function* (
  questions: ReadonlyArray<readonly [string, DecisionQuestion]>,
  output: Readonly<Record<string, unknown>>
) {
  const answers: Record<string, DecisionAnswer> = {}
  for (const [name, question] of questions) {
    const answer = selectedAnswer(question, output[name])
    if (answer === undefined) {
      return yield* invalidOutput(`The decision answer for ${name} is not one of its options`)
    }
    answers[name] = answer
  }
  return answers
})

const selectedAnswer = (question: DecisionQuestion, raw: unknown): DecisionAnswer | undefined => {
  if (question.kind === "box") return undefined
  if (question.kind === "predicate") {
    if (typeof raw !== "boolean") return undefined
    return {
      kind: "predicate",
      value: raw,
      distribution: {
        kind: "selected-only",
        probabilities: { true: raw ? 1 : 0, false: raw ? 0 : 1 }
      }
    }
  }
  const values = optionsOf(question).map((option) => option.value)
  const level = typeof raw === "string" ? values.indexOf(raw) : -1
  if (typeof raw !== "string" || level === -1) return undefined
  const distribution = {
    kind: "selected-only" as const,
    probabilities: Object.fromEntries(values.map((value) => [value, value === raw ? 1 : 0]))
  }
  return question.kind === "choice"
    ? { kind: "choice", value: raw, distribution }
    : { kind: "score", value: raw, level, distribution }
}

const answerSchema = (question: DecisionQuestion) => {
  switch (question.kind) {
    case "box":
      return Schema.Never
    case "predicate":
      return Schema.Boolean
    case "choice":
      return literalsOf(question.options)
    case "score":
      return literalsOf(question.levels)
  }
}

const literalsOf = (options: ChoiceOptions) => {
  const [first, ...rest] = options
  return Schema.Literals([first.value, ...rest.map((option) => option.value)])
}

type ChoiceOptions = Extract<DecisionQuestion, { kind: "choice" }>["options"]

const completionError = (cause: StructuredCompletionError): DecisionsError =>
  new DecisionsError({ reason: cause.reason, message: cause.message, cause })
