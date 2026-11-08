import type { JsonValue } from "@arden-hq/protocol"

import { markdownValue } from "../../prompts/format.js"
import { optionsOf, type DecisionInput, type DecisionQuestion } from "./questions.js"

export const stateText = (input: Pick<DecisionInput, "instructions" | "state">): string =>
  `${input.instructions.trim()}\n\n${stateMarkdown(input.state)}`

export const questionsText = (questions: DecisionInput["questions"]): string =>
  [
    "# Questions",
    ...Object.entries(questions).map(([name, question]) => questionLine(name, question))
  ].join("\n\n")

export const stateMarkdown = (state: JsonValue): string => {
  if (state === null || typeof state !== "object" || Array.isArray(state))
    return `# State\n\n${markdownValue(state)}`
  const sections = Object.entries(state).map(
    ([name, value]) => `## ${name}\n\n${markdownValue(value)}`
  )
  return ["# State", ...(sections.length === 0 ? ["Nothing."] : sections)].join("\n\n")
}

const questionLine = (name: string, question: DecisionQuestion): string => {
  const answers =
    question.kind === "predicate"
      ? "Answer true or false."
      : [
          "Answer with one of:",
          ...optionsOf(question).map(
            (option) =>
              `- ${option.value}${option.description === "" ? "" : `: ${option.description}`}`
          )
        ].join("\n")
  return `## ${name}\n\n${question.instructions.trim()}\n\n${answers}`
}
