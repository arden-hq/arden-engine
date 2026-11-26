import { Schema } from "effect"
import { expect, it } from "vitest"

import { answerSaid, answerWords } from "@arden-hq/protocol/runs"
import { RunQuestionAnswerSchema } from "@arden-hq/protocol/effect/runs"

const decodeAnswer = Schema.decodeUnknownExit(RunQuestionAnswerSchema)

const choices = [
  { id: "gmail", label: "Gmail" },
  { id: "drive", label: "Drive" }
]

it("several picks decode with or without the user's words, and never empty or repeated", () => {
  const none = { kind: "none" }
  expect(decodeAnswer({ kind: "choices", choice_ids: ["gmail", "drive"], typed: none })._tag).toBe(
    "Success"
  )
  expect(
    decodeAnswer({
      kind: "choices",
      choice_ids: ["gmail"],
      typed: { kind: "given", text: "Also Slack" }
    })._tag
  ).toBe("Success")
  expect(decodeAnswer({ kind: "choices", choice_ids: [], typed: none })._tag).toBe("Failure")
  expect(decodeAnswer({ kind: "choices", choice_ids: ["gmail", "gmail"], typed: none })._tag).toBe(
    "Failure"
  )
})

it("an answer says its picks in the question's order, then the typed words", () => {
  const said = answerSaid(choices, {
    kind: "choices",
    choice_ids: ["drive", "gmail"],
    typed: { kind: "given", text: "  Also Slack " }
  })
  expect(said).toEqual({ chosen: ["Gmail", "Drive"], typed: { kind: "given", text: "Also Slack" } })
  const words = said ? answerWords(said) : ""
  expect(words.indexOf("Gmail")).toBeGreaterThanOrEqual(0)
  expect(words.indexOf("Gmail")).toBeLessThan(words.indexOf("Drive"))
  expect(words.indexOf("Drive")).toBeLessThan(words.indexOf("Also Slack"))
  expect(answerSaid(choices, { kind: "choice", choice_id: "slack" })).toEqual({
    chosen: ["slack"],
    typed: { kind: "none" }
  })
  expect(answerSaid(choices, { kind: "hold" })).toBeUndefined()
})
