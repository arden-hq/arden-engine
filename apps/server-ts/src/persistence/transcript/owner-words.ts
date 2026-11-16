import { cutText } from "@arden-hq/std/text"
import { Predicate } from "effect"

const typedText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part: unknown) =>
      Predicate.isObject(part) && part.type === "text" && Predicate.isString(part.text)
        ? [part.text]
        : []
    )
    .join("\n")
}

const QUESTION_ANSWER = /^<question_answer>([\s\S]*)<\/question_answer>$/

const questionAnswerFields = (
  message: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | undefined => {
  const match = QUESTION_ANSWER.exec(typedText(message.content).trim())
  if (match === null) return undefined
  try {
    const body: unknown = JSON.parse(match[1] ?? "")
    return Predicate.isObject(body) ? body : undefined
  } catch {
    return undefined
  }
}

const MAX_ASKED_CHARS = 300

const jsonQuoted = (text: string): string =>
  JSON.stringify(text).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")

const answeredText = (body: Readonly<Record<string, unknown>>): string => {
  const prompt = Predicate.isString(body.prompt) ? body.prompt : undefined
  const asked =
    prompt === undefined
      ? []
      : [
          `Arden had asked (Arden's words, not the user's): ${jsonQuoted(
            cutText(prompt, MAX_ASKED_CHARS)
          )}`
        ]
  if (body.skipped === true) return ["The user skipped the question.", ...asked].join("\n")
  const answer = Predicate.isString(body.answer) ? body.answer : undefined
  if (answer === undefined) return ""
  return [`The user answered: ${jsonQuoted(answer)}`, ...asked].join("\n")
}

/**
 * What the owner said in `message`, which `TranscriptQueries.ownerWordsIn` (or
 * `ownerMessagesAfter`) proved is the owner's own words: the typed text, or an answer to Arden's
 * question with Arden's prompt marked as Arden's.
 */
export const ownerText = (message: Readonly<Record<string, unknown>>): string => {
  const typed = typedText(message.content)
  if (message.question_answer === undefined || !typed.trim().startsWith("<question_answer>"))
    return typed
  const body = questionAnswerFields(message)
  return body === undefined ? "" : answeredText(body)
}

/** What the owner typed in a proven `message`, without the choices Arden offered. */
export const ownerKeystrokes = (message: Readonly<Record<string, unknown>>): string => {
  if (!typedText(message.content).trim().startsWith("<question_answer>")) return ownerText(message)
  const ownAnswer = questionAnswerFields(message)?.own_answer
  return Predicate.isString(ownAnswer) ? ownAnswer : ""
}
