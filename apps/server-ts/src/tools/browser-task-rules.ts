import { Schema } from "effect"

import { atNodeRef } from "./browser-support.js"

const isAct = Schema.is(
  Schema.Struct({
    action: Schema.String,
    value: Schema.optionalKey(Schema.String),
    values: Schema.optionalKey(Schema.Array(Schema.String)),
    secret: Schema.optionalKey(Schema.String),
    target: Schema.optionalKey(Schema.Struct({ node_ref: Schema.optionalKey(Schema.String) }))
  })
)

const CHOICE_ROLES: ReadonlySet<string> = new Set([
  "radio",
  "option",
  "checkbox",
  "switch",
  "menuitemradio",
  "menuitemcheckbox"
])

const choiceOf = (label: string): string | undefined => {
  const space = label.indexOf(" ")
  const role = space < 0 ? label : label.slice(0, space)
  return CHOICE_ROLES.has(role) ? (labelName(label) ?? "") : undefined
}

const labelName = (label: string): string | undefined => {
  const space = label.indexOf(" ")
  if (space < 0) return undefined
  const name = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))(
    label.slice(space + 1)
  )
  return name._tag === "Some" ? name.value.trim() : undefined
}

const normalized = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim()

const valueLine = (
  line: string
): { readonly label: string; readonly value: string } | undefined => {
  const colon = line.indexOf(":")
  if (colon <= 0) return undefined
  const value = line.slice(colon + 1).trim()
  return value === "" ? undefined : { label: normalized(line.slice(0, colon)), value }
}

const digitsOf = (text: string): string => text.replace(/\D+/gu, "")
const isNumberLike = (text: string): boolean => /^[\s()+\-./]*$/u.test(text.replace(/\d+/gu, ""))
const words = (text: string): ReadonlyArray<string> =>
  text.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "")
const containsRun = (whole: ReadonlyArray<string>, part: ReadonlyArray<string>): boolean =>
  part.length > 0 &&
  whole.some((_, start) => part.every((word, offset) => whole[start + offset] === word))

export const typingRule = (brief: string, values: string) => {
  const candidates = values
    .split("\n")
    .flatMap((line) => {
      const parsed = valueLine(line)
      return parsed === undefined ? [line] : [line, parsed.value]
    })
    .map(normalized)
    .filter((candidate) => candidate !== "")
  const text = normalized(values)
  const briefWords = words(normalized(brief))
  const given = (typed: string): boolean => {
    const value = normalized(typed)
    if (value === "" || candidates.includes(value)) return true
    if (value.length >= 20 && text.includes(value)) return true
    if (candidates.some((candidate) => containsRun(words(candidate), words(value)))) return true
    if (value.length >= 3 && candidates.some((candidate) => candidate.startsWith(value)))
      return true
    if (!isNumberLike(typed)) return false
    const digits = digitsOf(typed)
    return (
      digits.length > 0 &&
      candidates.some((candidate) => {
        const number = digitsOf(candidate)
        if (number === "") return false
        return (
          number === digits ||
          (digits.length >= 7 && number.endsWith(digits)) ||
          candidate.split(/\D+/u).includes(digits)
        )
      })
    )
  }
  const named = (choice: string) =>
    given(choice) || containsRun(briefWords, words(normalized(choice)))
  return {
    given,
    named,
    answers: (choice: string) =>
      named(choice) ||
      candidates.some(
        (candidate) =>
          candidate.length >= 3 && containsRun(words(normalized(choice)), words(candidate))
      )
  }
}

export const refusalOf = (
  input: Readonly<Record<string, unknown>>,
  task: {
    readonly tabRef: string
    readonly origin: string
    readonly rule: ReturnType<typeof typingRule>
    readonly secrets: ReadonlyArray<string>
  },
  labelOf: (nodeRef: string) => string | undefined
): string | undefined => {
  if (input["tab_ref"] !== task.tabRef) return `This task works only in tab ${task.tabRef}.`
  if ("origin" in input && input["origin"] !== task.origin)
    return `This task works only on ${task.origin}; finish with blocked if the goal needs another site.`
  if (!isAct(input)) return undefined
  const picks = ["click", "dblclick", "check", "uncheck"].includes(input.action)
  const nodeRef = input.target?.node_ref
  if (picks && input.target !== undefined && nodeRef === undefined)
    return "Aim this at an element by its ref from the latest page."
  const label = picks && nodeRef !== undefined ? labelOf(atNodeRef(nodeRef)) : undefined
  if (picks && nodeRef !== undefined && label === undefined && input.action !== "click")
    return "Arden cannot tell what this box says; finish with decide and name it."
  const choice = label === undefined ? undefined : choiceOf(label)
  if (choice === "")
    return "Arden cannot read this choice's name; finish with decide and name the question."
  if (choice !== undefined && !task.rule.answers(choice))
    return `The choice "${choice}" is not named in this task; finish with decide and name the question.`
  if (input.secret !== undefined && !task.secrets.includes(input.secret))
    return `The saved secret ${input.secret} is not one this task may fill.`
  if (
    (input.action === "fill" || input.action === "type") &&
    input.value !== undefined &&
    !task.rule.given(input.value)
  )
    return "That value is not among the values given for this task; type only those, or finish with decide."
  if (
    input.action === "select" &&
    (input.values ?? []).some((option) => !task.rule.answers(option))
  )
    return "That choice is not named in this task; finish with decide and name the field."
  return undefined
}
