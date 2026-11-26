import { Option, Schema } from "effect"
import type { JsonObject } from "../json.js"
import { StoredRunQuestionSchema, wireRunQuestion } from "./stored-question.js"

const decodeStoredQuestion = Schema.decodeUnknownOption(StoredRunQuestionSchema)

export const upgradeQuestionData = (data: JsonObject): JsonObject => {
  if (!("question" in data)) return data
  const stored = decodeStoredQuestion(data["question"])
  return Option.isSome(stored) ? { ...data, question: wireRunQuestion(stored.value) } : data
}

export const resultDataEntry = (
  data: JsonObject | null | undefined
): { readonly data?: JsonObject } =>
  data === undefined || data === null ? {} : { data: upgradeQuestionData(data) }
