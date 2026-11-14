// The memory test's question file and the folders it may touch. The question file is the
// owner's private list of questions with dated answers: it lives beside the research notes,
// never in this repository, and every result is written beside it.

import { readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Schema } from "effect"
import { isWithin } from "@arden-hq/std/paths"
import { assertReplayFolder, type ReplayFolder } from "../replay-folder.js"

/** The kinds of question, in the order the tables print them. */
export const QUESTION_KINDS = [
  "personal_fact",
  "where_it_stands",
  "did_before",
  "people",
  "standing_rule",
  "changed_fact",
  "no_answer",
  "multi_hop",
  "adversarial"
] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

const base = {
  id: Schema.NonEmptyString,
  question: Schema.NonEmptyString,
  /** The Space a new chat for this question opens in; null for Home. */
  space_id: Schema.NullOr(Schema.NonEmptyString)
}

const AnsweredQuestion = Schema.Struct({
  ...base,
  kind: Schema.Literals([
    "personal_fact",
    "where_it_stands",
    "did_before",
    "people",
    "changed_fact",
    "multi_hop",
    "adversarial"
  ]),
  expected_answer: Schema.NonEmptyString,
  /** Memory page paths, relative to the pages folder, that hold the answer. */
  expected_pages: Schema.NonEmptyArray(Schema.NonEmptyString)
})

const RuleQuestion = Schema.Struct({
  ...base,
  kind: Schema.Literal("standing_rule"),
  expected_behavior: Schema.NonEmptyString,
  expected_pages: Schema.NonEmptyArray(Schema.NonEmptyString)
})

const NoAnswerQuestion = Schema.Struct({
  ...base,
  kind: Schema.Literal("no_answer"),
  expected_answer: Schema.NonEmptyString,
  expected_pages: Schema.Tuple([]),
  /** Case-insensitive patterns; a match in what a chat is sent would mislead it. */
  misleading: Schema.NonEmptyArray(Schema.NonEmptyString)
})

const Question = Schema.Union([AnsweredQuestion, RuleQuestion, NoAnswerQuestion])
export type Question = typeof Question.Type

const QuestionFile = Schema.Struct({
  version: Schema.Literal(1),
  approved: Schema.NonEmptyString,
  questions: Schema.NonEmptyArray(Question)
})

/** Decodes a question file's text. Refuses an unknown shape and a repeated id. */
export const parseQuestions = (text: string): ReadonlyArray<Question> => {
  const { questions } = Schema.decodeUnknownSync(Schema.fromJsonString(QuestionFile))(text)
  const ids = new Set<string>()
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error(`Question ${question.id} appears twice`)
    ids.add(question.id)
  }
  return questions
}

/** The engine repository, which must never hold the questions or the results. */
const REPOSITORY = realpathSync(resolve(import.meta.dirname, "../../../.."))

export interface MemoryTestFiles {
  readonly questions: ReadonlyArray<Question>
  /** The folder that holds the question file; results are written here. */
  readonly results: string
  readonly copy: ReplayFolder
}

/**
 * The inputs of a memory test run: the private question file, outside this repository, and a
 * replay copy that passes the replay folder guard (so never the owner's real data folder).
 */
export const memoryTestFiles = (input: {
  readonly questions: string
  readonly copy: string
}): MemoryTestFiles => {
  const questionFile = realpathSync(resolve(input.questions))
  if (isWithin(REPOSITORY, questionFile))
    throw new Error(
      `Refusing question file ${questionFile}: it is inside the repository, and the questions and results are private`
    )
  const copy = assertReplayFolder(input.copy)
  return {
    questions: parseQuestions(readFileSync(questionFile, "utf8")),
    results: dirname(questionFile),
    copy
  }
}
