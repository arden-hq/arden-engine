// The "answered" half of the memory test, planned and priced but not run: each question asked
// in three fresh chats on the replay copy with a model, each reply judged against the dated
// expected answer. This prints the plan and the cost of one pass, from first turns measured on
// the copy, and sends nothing to a model. The paid run itself is not built: given the paid
// flag, it says so and fails; given any other flag, it refuses.
//
// Run it with `just memory-test-answered <question file> <replay folder> [--paid-run]`. It runs
// under vitest and opens the copy only through test/fixtures/replay-copy.ts.

import { existsSync } from "node:fs"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { it } from "vitest"
import { runOnReplayCopy } from "../test/fixtures/replay-copy.js"
import {
  answeredMode,
  estimatePass,
  measureFirstTurns,
  PAID_RUN_FLAG,
  planAnswered
} from "./memory-test/answered.js"
import { memoryTestFiles } from "./memory-test/questions.js"

const required = (name: string): string => {
  const value = process.env[name]?.trim() ?? ""
  if (value === "") throw new Error(`${name} is not set; run \`just memory-test-answered\``)
  return value
}

it("plans and prices one answered pass, and sends nothing to a model", async () => {
  const mode = answeredMode(process.env.ARDEN_MEMORY_TEST_FLAGS ?? "")
  const files = memoryTestFiles({
    questions: required("ARDEN_MEMORY_TEST_QUESTIONS"),
    copy: required("ARDEN_REPLAY_COPY")
  })
  if (!existsSync(files.copy.database))
    throw new Error(`No replay copy at ${files.copy.database}; run \`just replay-copy\` first`)
  const usage = await runOnReplayCopy(
    files.copy,
    Effect.gen(function* () {
      return yield* measureFirstTurns(yield* SqlClient.SqlClient)
    })
  )
  const estimate = estimatePass(files.questions, usage)
  const round = (value: number) => Math.round(value).toLocaleString("en-US")
  // Vitest swallows console output here; a direct write reaches the terminal.
  process.stdout.write(
    [
      "",
      `Answered pass, planned: ${planAnswered(files.questions).length} fresh chats (${files.questions.length} questions, 3 runs each), one judge request per chat.`,
      `Measured first turns: ${usage.runs} runs in the 30 days to ${usage.through}, ${estimate.requestsPerChat.toFixed(2)} requests and ${round(estimate.freshInputTokensPerChat)} fresh input tokens each.`,
      `Chats: ${round(estimate.chatRequests)} requests, ${round(estimate.chatFreshInputTokens)} fresh input tokens.`,
      `Judge: ${round(estimate.judgeRequests)} requests, about ${round(estimate.judgeFreshInputTokens)} fresh input tokens.`,
      `Per pass: ${round(estimate.requests)} model requests, ${round(estimate.freshInputTokens)} fresh input tokens.`,
      "Nothing was sent to a model.",
      mode === "plan" ? `A paid run needs ${PAID_RUN_FLAG}.` : "",
      ""
    ].join("\n")
  )
  if (mode === "paid")
    throw new Error(
      "The paid answered runner is not built yet. Nothing was run; it needs the owner's approval of this estimate first."
    )
}, 3_600_000)
