import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { userChatSql } from "../../src/persistence/sqlite/chat-ownership.js"
import { QUESTION_KIND, type Question } from "./questions.js"

export const PAID_RUN_FLAG = "--paid-run"

export const ANSWERED_MODE = { plan: "plan", paid: "paid" } as const
type AnsweredMode = (typeof ANSWERED_MODE)[keyof typeof ANSWERED_MODE]

export const answeredMode = (flags: string): AnsweredMode => {
  const given = flags.trim()
  if (given === "") return ANSWERED_MODE.plan
  if (given === PAID_RUN_FLAG) return ANSWERED_MODE.paid
  throw new Error(`Unknown flags: ${given}. The only flag is ${PAID_RUN_FLAG}.`)
}

export const RUNS_PER_QUESTION = 3
const RUNS_TO_PASS = 2

export interface PlannedChat {
  readonly questionId: string
  readonly run: number
  readonly spaceId: string | null
  readonly firstMessage: string
}

export const planAnswered = (questions: ReadonlyArray<Question>): ReadonlyArray<PlannedChat> =>
  questions.flatMap((question) =>
    Array.from({ length: RUNS_PER_QUESTION }, (_, index) => ({
      questionId: question.id,
      run: index + 1,
      spaceId: question.space_id,
      firstMessage: question.question
    }))
  )

const KIND_RULE: Record<Question["kind"], string> = {
  personal_fact: "Pass only if the reply states the expected facts.",
  where_it_stands: "Pass only if the reply states where things stand as expected.",
  did_before: "Pass only if the reply recalls what was done before, as expected.",
  people: "Pass only if the reply identifies the person or organisation as expected.",
  changed_fact:
    "The fact changed once. Pass only if the reply gives the current value; the old value fails.",
  multi_hop: "The answer joins two facts. Pass only if the reply reaches the expected conclusion.",
  adversarial:
    "The question carries a wrong or stale premise. Pass only if the reply corrects it; going along with the premise fails.",
  no_answer:
    "Memory holds no answer. Pass only if the reply says it does not know; any guess fails.",
  standing_rule:
    "This is a request, judged by what the assistant did. Pass only if its actions follow the expected behavior."
}

const DATE_RULE =
  "Where the expected answer carries a date, the reply must carry the same date; a missing or different date fails."

const expectation = (question: Question): string =>
  question.kind === QUESTION_KIND.standingRule
    ? `Expected behavior: ${question.expected_behavior}`
    : `Expected answer: ${question.expected_answer}`

export interface ChatOutcome {
  readonly reply: string
  readonly actions: ReadonlyArray<string>
}

export const judgePrompt = (question: Question, outcome: ChatOutcome): string =>
  [
    "You judge one reply of a personal assistant against an expected answer the user approved.",
    KIND_RULE[question.kind],
    ...(question.kind === QUESTION_KIND.standingRule ? [] : [DATE_RULE]),
    "Extra correct detail is fine. A vague reply that does not commit to the expected facts fails.",
    "",
    `Request: ${question.question}`,
    expectation(question),
    "",
    "Reply:",
    outcome.reply,
    "",
    "Actions:",
    ...(outcome.actions.length === 0 ? ["(none)"] : outcome.actions),
    "",
    'Answer with JSON only: {"verdict": "pass" | "fail", "reason": "<one sentence>"}'
  ].join("\n")

const VERDICT = { pass: "pass", fail: "fail" } as const

const Verdict = Schema.fromJsonString(
  Schema.Struct({
    verdict: Schema.Literals([VERDICT.pass, VERDICT.fail]),
    reason: Schema.NonEmptyString
  })
)
const decodeVerdict = Schema.decodeUnknownOption(Verdict)

export interface JudgedRun {
  readonly questionId: string
  readonly run: number
  readonly judge: string
}

export interface AnsweredResult {
  readonly id: string
  readonly kind: Question["kind"]
  readonly passed: number
  readonly malformed: number
  readonly answered: boolean
}

export const scoreJudged = (
  questions: ReadonlyArray<Question>,
  runs: ReadonlyArray<JudgedRun>
): ReadonlyArray<AnsweredResult> => {
  const key = (questionId: string, run: number) => `${questionId}#${run}`
  const byKey = new Map<string, JudgedRun>()
  for (const run of runs) {
    const id = key(run.questionId, run.run)
    if (byKey.has(id)) throw new Error(`Run ${id} was judged twice`)
    byKey.set(id, run)
  }
  const planned = new Set(planAnswered(questions).map((chat) => key(chat.questionId, chat.run)))
  const extra = [...byKey.keys()].filter((id) => !planned.has(id))
  if (extra.length > 0) throw new Error(`Runs not in the plan: ${extra.join(", ")}`)
  const absent = [...planned].filter((id) => !byKey.has(id))
  if (absent.length > 0) throw new Error(`Runs not judged: ${absent.join(", ")}`)
  return questions.map((question) => {
    const verdicts = Array.from({ length: RUNS_PER_QUESTION }, (_, index) => {
      const judged = byKey.get(key(question.id, index + 1))
      return judged === undefined ? undefined : decodeVerdict(judged.judge.trim())
    })
    const passed = verdicts.filter(
      (verdict) =>
        verdict !== undefined && Option.isSome(verdict) && verdict.value.verdict === VERDICT.pass
    ).length
    const malformed = verdicts.filter(
      (verdict) => verdict === undefined || Option.isNone(verdict)
    ).length
    return {
      id: question.id,
      kind: question.kind,
      passed,
      malformed,
      answered: passed >= RUNS_TO_PASS
    }
  })
}

export interface FirstTurnUsage {
  readonly runs: number
  readonly requests: number
  readonly freshInputTokens: number
  readonly through: string
}

export const measureFirstTurns = Effect.fn("MemoryTest.measureFirstTurns")(function* (
  sql: SqlClient.SqlClient
) {
  const rows = yield* sql<{
    readonly runs: number
    readonly requests: number
    readonly fresh: number
    readonly through: string | null
  }>`
    WITH newest AS (SELECT max(started_at) AS at FROM chat_runs),
    first_runs AS (
      SELECT run.run_id FROM chat_runs AS run
      JOIN sessions AS chat ON chat.session_id = run.session_id
      WHERE ${userChatSql("chat")}
        AND run.started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT at FROM newest), '-30 days')
        AND run.started_at = (
          SELECT min(earlier.started_at) FROM chat_runs AS earlier
          WHERE earlier.session_id = run.session_id)
    )
    SELECT count(DISTINCT usage.run_id) AS runs, count(*) AS requests,
      coalesce(sum(json_extract(usage.usage_json, '$.prompt')), 0) AS fresh,
      (SELECT at FROM newest) AS through
    FROM first_runs JOIN run_model_usage AS usage ON usage.run_id = first_runs.run_id
    WHERE usage.usage_json IS NOT NULL`
  const row = rows[0]
  if (row === undefined || row.through === null)
    return yield* Effect.die(new Error("The copy holds no chat runs"))
  return {
    runs: row.runs,
    requests: row.requests,
    freshInputTokens: row.fresh,
    through: row.through
  } satisfies FirstTurnUsage
})

export interface PassEstimate {
  readonly chats: number
  readonly requestsPerChat: number
  readonly freshInputTokensPerChat: number
  readonly chatRequests: number
  readonly chatFreshInputTokens: number
  readonly judgeRequests: number
  readonly judgeFreshInputTokens: number
  readonly requests: number
  readonly freshInputTokens: number
}

const CHARACTERS_PER_TOKEN = 4

export const estimatePass = (
  questions: ReadonlyArray<Question>,
  usage: FirstTurnUsage
): PassEstimate => {
  if (usage.runs === 0) throw new Error("No measured first turns to estimate from")
  const chats = planAnswered(questions)
  const byId = new Map(questions.map((question) => [question.id, question] as const))
  const requestsPerChat = usage.requests / usage.runs
  const freshInputTokensPerChat = usage.freshInputTokens / usage.runs
  const chatRequests = Math.round(chats.length * requestsPerChat)
  const chatFreshInputTokens = Math.round(chats.length * freshInputTokensPerChat)
  const judgeFreshInputTokens = Math.round(
    chats.reduce((sum, chat) => {
      const question = byId.get(chat.questionId)
      if (question === undefined) return sum
      const stand = question.kind === QUESTION_KIND.standingRule ? "" : question.expected_answer
      return sum + judgePrompt(question, { reply: stand, actions: [] }).length
    }, 0) / CHARACTERS_PER_TOKEN
  )
  return {
    chats: chats.length,
    requestsPerChat,
    freshInputTokensPerChat,
    chatRequests,
    chatFreshInputTokens,
    judgeRequests: chats.length,
    judgeFreshInputTokens,
    requests: chatRequests + chats.length,
    freshInputTokens: chatFreshInputTokens + judgeFreshInputTokens
  }
}
