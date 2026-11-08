import { Schema } from "effect"
import { expect, it } from "vitest"

import { answerSaid, answerWords, settledQuestionDrawn } from "@arden-hq/protocol/runs"
import { RunQuestionAnswerSchema, RunQuestionContentSchema } from "@arden-hq/protocol/effect/runs"

const decodeContent = Schema.decodeUnknownExit(RunQuestionContentSchema)
const decodeAnswer = Schema.decodeUnknownExit(RunQuestionAnswerSchema)

const choices = [
  { id: "gmail", label: "Gmail" },
  { id: "drive", label: "Drive" }
]

it("questions and answers stored before multi-select still decode", () => {
  const stored = { prompt: "Which account?", detail: null, choices }
  expect(decodeContent(stored)._tag).toBe("Success")
  expect(decodeContent({ ...stored, multiple: true })._tag).toBe("Success")
  for (const answer of [
    { kind: "text", text: "The work one" },
    { kind: "choice", choice_id: "gmail" },
    { kind: "hold" },
    { kind: "dismiss" }
  ])
    expect(decodeAnswer(answer)._tag).toBe("Success")
})

it("several picks decode with or without the user's words, and never empty or repeated", () => {
  expect(decodeAnswer({ kind: "choices", choice_ids: ["gmail", "drive"] })._tag).toBe("Success")
  expect(decodeAnswer({ kind: "choices", choice_ids: ["gmail"], text: "Also Slack" })._tag).toBe(
    "Success"
  )
  expect(decodeAnswer({ kind: "choices", choice_ids: [] })._tag).toBe("Failure")
  expect(decodeAnswer({ kind: "choices", choice_ids: ["gmail", "gmail"] })._tag).toBe("Failure")
})

it("an answer says its picks in the question's order, then the typed words", () => {
  const said = answerSaid(choices, {
    kind: "choices",
    choice_ids: ["drive", "gmail"],
    text: "  Also Slack "
  })
  expect(said).toEqual({ chosen: ["Gmail", "Drive"], typed: "Also Slack" })
  expect(said && answerWords(said)).toBe("Gmail, Drive; Also Slack")
  expect(answerSaid(choices, { kind: "choice", choice_id: "slack" })).toEqual({
    chosen: ["slack"],
    typed: undefined
  })
  expect(answerSaid(choices, { kind: "hold" })).toBeUndefined()
})

it.each([
  ["resolved", true],
  ["closed", false],
  ["suspended", false],
  ["open", false]
] as const)("%s questions require a transcript acknowledgement: %s", (status, expected) => {
  expect(settledQuestionDrawn({ status })).toBe(expected)
})
