import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"
import {
  answeredMode,
  estimatePass,
  judgePrompt,
  measureFirstTurns,
  PAID_RUN_FLAG,
  planAnswered,
  scoreJudged,
  type JudgedRun
} from "../scripts/memory-test/answered.js"
import { parseQuestions } from "../scripts/memory-test/questions.js"

// Made-up questions; nothing here comes from anyone's Memory.

const questions = parseQuestions(
  JSON.stringify({
    version: 1,
    approved: "2026-01-01",
    questions: [
      {
        id: "q1",
        kind: "where_it_stands",
        question: "Where does the garden plan stand?",
        space_id: "space-garden",
        expected_answer: "Seeds ordered on 2 March 2026.",
        expected_pages: ["projects/garden.md"]
      },
      {
        id: "q2",
        kind: "adversarial",
        question: "When is my boat race?",
        space_id: null,
        expected_answer: "There is none; the race was cancelled on 1 May 2026.",
        expected_pages: ["projects/boat.md"]
      },
      {
        id: "q3",
        kind: "no_answer",
        question: "What is my shoe size?",
        space_id: null,
        expected_answer: "Says it does not know.",
        expected_pages: [],
        misleading: ["shoe size"]
      },
      {
        id: "q4",
        kind: "standing_rule",
        question: "Tidy my desk.",
        space_id: null,
        expected_behavior: "Asks before it throws anything away.",
        expected_pages: ["me.md"]
      }
    ]
  })
)

const verdict = (value: "pass" | "fail") => JSON.stringify({ verdict: value, reason: "Checked." })

const judged = (verdicts: Record<string, ReadonlyArray<string>>): ReadonlyArray<JudgedRun> =>
  Object.entries(verdicts).flatMap(([questionId, outputs]) =>
    outputs.map((judge, index) => ({ questionId, run: index + 1, judge }))
  )

describe("answered runner, without a model", () => {
  it("plans three fresh chats a question, each opening with the question in its Space", () => {
    const plan = planAnswered(questions)
    expect(plan).toHaveLength(12)
    expect(plan.filter((chat) => chat.questionId === "q1")).toEqual(
      [1, 2, 3].map((run) => ({
        questionId: "q1",
        run,
        spaceId: "space-garden",
        firstMessage: "Where does the garden plan stand?"
      }))
    )
  })

  it("the judge prompt carries the expected answer, the kind rule and the date rule", () => {
    const [stands, premise, none, rule] = questions
    if (stands === undefined || premise === undefined || none === undefined || rule === undefined)
      throw new Error("fixture")
    const outcome = { reply: "The seeds are ordered.", actions: [] }
    const prompt = judgePrompt(stands, outcome)
    expect(prompt).toContain("Expected answer: Seeds ordered on 2 March 2026.")
    expect(prompt).toContain("the same date")
    expect(prompt).toContain("The seeds are ordered.")
    expect(prompt).toContain('{"verdict": "pass" | "fail"')
    expect(judgePrompt(premise, outcome)).toContain("corrects it")
    expect(judgePrompt(none, outcome)).toContain("any guess fails")
    const rulePrompt = judgePrompt(rule, { reply: "Done.", actions: ["files_delete {}"] })
    expect(rulePrompt).toContain("Expected behavior: Asks before it throws anything away.")
    expect(rulePrompt).toContain("files_delete {}")
    expect(rulePrompt).not.toContain("the same date")
  })

  it("a question is answered on two passing runs of three; a malformed verdict fails its run", () => {
    const results = scoreJudged(
      questions,
      judged({
        q1: [verdict("pass"), verdict("fail"), verdict("pass")],
        q2: [verdict("pass"), "PASS", "```json\n{}\n```"],
        q3: [verdict("fail"), verdict("fail"), verdict("pass")],
        q4: [verdict("pass"), verdict("pass"), verdict("pass")]
      })
    )
    expect(
      results.map(({ id, passed, malformed, answered }) => [id, passed, malformed, answered])
    ).toEqual([
      ["q1", 2, 0, true],
      ["q2", 1, 2, false],
      ["q3", 1, 0, false],
      ["q4", 3, 0, true]
    ])
  })

  it("refuses to score an incomplete or doubled pass", () => {
    const full = judged({
      q1: [verdict("pass"), verdict("pass"), verdict("pass")],
      q2: [verdict("pass"), verdict("pass"), verdict("pass")],
      q3: [verdict("pass"), verdict("pass"), verdict("pass")],
      q4: [verdict("pass"), verdict("pass"), verdict("pass")]
    })
    expect(() => scoreJudged(questions, full.slice(1))).toThrow(/not judged: q1#1/)
    expect(() => scoreJudged(questions, [...full, ...full.slice(0, 1)])).toThrow(/judged twice/)
    expect(() =>
      scoreJudged(questions, [...full, { questionId: "q1", run: 4, judge: verdict("pass") }])
    ).toThrow(/not in the plan/)
  })

  it("estimates a pass from measured first turns, plus one judge request a run", () => {
    const measured = { runs: 10, requests: 50, freshInputTokens: 400_000, through: "2026-03-26" }
    const estimate = estimatePass(questions, measured)
    expect(estimate).toMatchObject({
      chats: 12,
      requestsPerChat: 5,
      freshInputTokensPerChat: 40_000,
      chatRequests: 60,
      chatFreshInputTokens: 480_000,
      judgeRequests: 12,
      requests: 72
    })
    expect(estimate.judgeFreshInputTokens).toBeGreaterThan(0)
    expect(estimate.freshInputTokens).toBe(480_000 + estimate.judgeFreshInputTokens)
    expect(() =>
      estimatePass(questions, { ...measured, runs: 0, requests: 0, freshInputTokens: 0 })
    ).toThrow()
  })

  it("measures first turns of owner chats over the last 30 days, uncached prompt only", async () => {
    const measured = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedUsage(sql)
        return yield* measureFirstTurns(sql)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
    )
    expect(measured).toEqual({
      runs: 2,
      requests: 6,
      freshInputTokens: 2 * 1_000 + 4 * 2_000,
      through: "2026-03-26T10:00:00.000Z"
    })
  })

  it("plans only, unless the paid flag is given, and refuses any other flag", () => {
    expect(answeredMode("")).toBe("plan")
    expect(answeredMode(` ${PAID_RUN_FLAG} `)).toBe("paid")
    expect(() => answeredMode("--paid")).toThrow(/Unknown flags/)
    expect(() => answeredMode(`${PAID_RUN_FLAG} --yes`)).toThrow(/Unknown flags/)
  })
})

/** Two owner chats' first runs in the window; a later run, an Automation's chat and an old first
 * run that the measure must leave out. */
const seedUsage = Effect.fn("seedUsage")(function* (sql: SqlClient.SqlClient) {
  yield* sql`CREATE TABLE sessions (session_id TEXT, session_type TEXT, origin_automation_id TEXT)`
  yield* sql`CREATE TABLE chat_runs (run_id TEXT, session_id TEXT, started_at TEXT)`
  yield* sql`CREATE TABLE run_model_usage (run_id TEXT, sample_id TEXT, usage_json TEXT)`
  yield* sql`INSERT INTO sessions VALUES ('chat-a', 'chat', NULL), ('chat-b', 'chat', NULL),
    ('chat-old', 'chat', NULL), ('chat-auto', 'chat', 'automation-1')`
  yield* sql`INSERT INTO chat_runs VALUES
    ('run-a1', 'chat-a', '2026-03-20T10:00:00.000Z'),
    ('run-a2', 'chat-a', '2026-03-21T10:00:00.000Z'),
    ('run-b1', 'chat-b', '2026-03-25T10:00:00.000Z'),
    ('run-old', 'chat-old', '2026-01-01T10:00:00.000Z'),
    ('run-auto', 'chat-auto', '2026-03-26T10:00:00.000Z')`
  const runs: ReadonlyArray<readonly [string, number, number]> = [
    ["run-a1", 2, 1_000],
    ["run-a2", 5, 7_000],
    ["run-b1", 4, 2_000],
    ["run-old", 3, 7_000],
    ["run-auto", 3, 7_000]
  ]
  for (const [runId, count, prompt] of runs)
    for (let index = 0; index < count; index += 1)
      yield* sql`INSERT INTO run_model_usage VALUES (${runId}, ${`${runId}-${index}`},
        ${JSON.stringify({ prompt, cache_read: 9_000 })})`
})
