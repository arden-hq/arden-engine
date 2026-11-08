import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ResolveRunQuestionInput } from "@arden-hq/protocol/runs"
import { settlePermissionOfferInTransaction } from "./permission-offers.js"
import { settleContractProposalInTransaction } from "./task-contract.js"

export const closeQuestionInTransaction = Effect.fn("RunQuestion.close")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly questionId: string
  readonly timer: "cancelled" | "elapsed"
  readonly now: string
}) {
  const { sql, questionId, now } = options
  yield* sql`UPDATE run_questions SET closed_at = ${now}
    WHERE question_id = ${questionId} AND resolution IS NULL AND closed_at IS NULL`
  yield* sql`UPDATE run_question_timers SET status = ${options.timer}
    WHERE question_id = ${questionId} AND status = 'pending'`
})

export const answerQuestionInTransaction = Effect.fn("RunQuestion.answer")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly questionId: string
  readonly clientId: string
  readonly answer: ResolveRunQuestionInput["answer"]
  readonly now: string
}) {
  const { sql, questionId, answer, now } = options
  yield* sql`UPDATE run_questions SET resolution = ${JSON.stringify({
    client_id: options.clientId,
    answer,
    resolved_at: now
  })}
    WHERE question_id = ${questionId} AND resolution IS NULL AND closed_at IS NULL`
  yield* sql`UPDATE run_question_timers SET status = 'cancelled'
    WHERE question_id = ${questionId} AND status = 'pending'`
  yield* settlePermissionOfferInTransaction({ sql, questionId, answer, now })
  yield* settleContractProposalInTransaction({ sql, questionId, answer, now })
})
