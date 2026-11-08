import {
  answerSaid,
  answerWords,
  type ResolveRunQuestionInput,
  type RunQuestion
} from "@arden-hq/protocol/runs"

type Answer = ResolveRunQuestionInput["answer"]
type Asked = Pick<RunQuestion, "question_id" | "content">

export const answerMisfit = (content: Asked["content"], answer: Answer): string | undefined => {
  const offered = (id: string) => content.choices.some((choice) => choice.id === id)
  switch (answer.kind) {
    case "choice":
      return offered(answer.choice_id) ? undefined : "That choice does not belong to this question"
    case "choices":
      if (content.multiple !== true) return "This question takes one choice"
      return answer.choice_ids.every(offered)
        ? undefined
        : "That choice does not belong to this question"
    case "text":
    case "hold":
    case "wait":
    case "dismiss":
      return undefined
  }
}

export const questionAnswerBody = (question: Asked, answer: Answer): string | undefined => {
  if (answer.kind === "dismiss")
    return `<question_answer>${JSON.stringify({
      question_id: question.question_id,
      prompt: question.content.prompt,
      skipped: true,
      instruction:
        "The user skipped this question. Continue without this answer within your existing authority. Do not ask it again or treat skipping as consent or permission."
    })}</question_answer>`
  if (answer.kind === "wait") return undefined
  const said = answerSaid(question.content.choices, answer)
  if (said === undefined) return undefined
  const several =
    question.content.multiple === true || answer.kind === "choices" ? { chosen: said.chosen } : {}
  const typed = said.typed === undefined ? {} : { own_answer: said.typed }
  return `<question_answer>${JSON.stringify({
    question_id: question.question_id,
    prompt: question.content.prompt,
    answer: answerWords(said),
    ...several,
    ...typed,
    instruction: "Continue from this answer within your existing authority."
  })}</question_answer>`
}
