import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Schema } from "effect"
import { assertReplayFolder, type ReplayFolder } from "../replay-folder.js"

export const QUESTION_KIND = {
  personalFact: "personal_fact",
  whereItStands: "where_it_stands",
  didBefore: "did_before",
  people: "people",
  standingRule: "standing_rule",
  changedFact: "changed_fact",
  noAnswer: "no_answer",
  multiHop: "multi_hop",
  adversarial: "adversarial"
} as const
export type QuestionKind = (typeof QUESTION_KIND)[keyof typeof QUESTION_KIND]
export const QUESTION_KINDS: ReadonlyArray<QuestionKind> = Object.values(QUESTION_KIND)

const base = {
  id: Schema.NonEmptyString,
  question: Schema.NonEmptyString,
  space_id: Schema.NullOr(Schema.NonEmptyString)
}

const AnsweredQuestion = Schema.Struct({
  ...base,
  kind: Schema.Literals([
    QUESTION_KIND.personalFact,
    QUESTION_KIND.whereItStands,
    QUESTION_KIND.didBefore,
    QUESTION_KIND.people,
    QUESTION_KIND.changedFact,
    QUESTION_KIND.multiHop,
    QUESTION_KIND.adversarial
  ]),
  expected_answer: Schema.NonEmptyString,
  expected_pages: Schema.NonEmptyArray(Schema.NonEmptyString)
})

const RuleQuestion = Schema.Struct({
  ...base,
  kind: Schema.Literal(QUESTION_KIND.standingRule),
  expected_behavior: Schema.NonEmptyString,
  expected_pages: Schema.NonEmptyArray(Schema.NonEmptyString)
})

const NoAnswerQuestion = Schema.Struct({
  ...base,
  kind: Schema.Literal(QUESTION_KIND.noAnswer),
  expected_answer: Schema.NonEmptyString,
  expected_pages: Schema.Tuple([]),
  misleading: Schema.NonEmptyArray(Schema.NonEmptyString)
})

const Question = Schema.Union([AnsweredQuestion, RuleQuestion, NoAnswerQuestion])
export type Question = typeof Question.Type

const QuestionFile = Schema.Struct({
  version: Schema.Literal(1),
  approved: Schema.NonEmptyString,
  questions: Schema.NonEmptyArray(Question)
})

export const parseQuestions = (text: string): ReadonlyArray<Question> => {
  const { questions } = Schema.decodeUnknownSync(Schema.fromJsonString(QuestionFile))(text)
  const ids = new Set<string>()
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error(`Question ${question.id} appears twice`)
    ids.add(question.id)
  }
  return questions
}

const gitCheckoutOf = (file: string): string | undefined => {
  for (let folder = dirname(file); ; folder = dirname(folder)) {
    if (existsSync(join(folder, ".git"))) return folder
    if (dirname(folder) === folder) return undefined
  }
}

export interface MemoryTestFiles {
  readonly questions: ReadonlyArray<Question>
  readonly results: string
  readonly copy: ReplayFolder
}

export const memoryTestFiles = (input: {
  readonly questions: string
  readonly copy: string
}): MemoryTestFiles => {
  const questionFile = realpathSync(resolve(input.questions))
  const checkout = gitCheckoutOf(questionFile)
  if (checkout !== undefined)
    throw new Error(
      `Refusing question file ${questionFile}: it is inside the git checkout ${checkout}, and the questions and results are private`
    )
  const copy = assertReplayFolder(input.copy)
  return {
    questions: parseQuestions(readFileSync(questionFile, "utf8")),
    results: dirname(questionFile),
    copy
  }
}
