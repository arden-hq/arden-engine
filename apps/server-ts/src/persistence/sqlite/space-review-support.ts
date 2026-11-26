import { STORED_RUN_STATUS } from "./status-sets.js"
import { SPACE_REVIEW_DISPOSITION } from "../automations/space-review.js"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { AutomationStoreError } from "../automations/store.js"
import { canonicalProposalId, REVIEWED_TASK_FIELDS } from "../automations/space-review.js"
import { runChanged } from "./run-effects.js"
import { type SqlError } from "effect/unstable/sql/SqlError"

export const REVIEWED_TASK_COLUMNS = REVIEWED_TASK_FIELDS.map(
  (field) => `'${field}', ${field}`
).join(", ")

export const failure = (
  reason: AutomationStoreError["reason"],
  message: string,
  cause?: unknown
): AutomationStoreError =>
  new AutomationStoreError({
    operation: "space_review",
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const REVIEW_RUN_STATE = { completed: "completed", failed: "failed", running: "running" } as const

type ReviewRunState = (typeof REVIEW_RUN_STATE)[keyof typeof REVIEW_RUN_STATE]

export const reviewRunState = (state: string): ReviewRunState => {
  switch (state) {
    case STORED_RUN_STATUS.running:
      return REVIEW_RUN_STATE.running
    case STORED_RUN_STATUS.failed:
    case STORED_RUN_STATUS.cancelled:
    case STORED_RUN_STATUS.interrupted:
      return REVIEW_RUN_STATE.failed
    default:
      return REVIEW_RUN_STATE.completed
  }
}

export const reviewRunMessage = (state: ReviewRunState, outcome: string | null): string => {
  switch (state) {
    case REVIEW_RUN_STATE.running:
      return "The Space is rechecking this offer."
    case REVIEW_RUN_STATE.failed:
      return "The Space review failed. You can recheck this offer again."
    case REVIEW_RUN_STATE.completed:
      return outcome === SPACE_REVIEW_DISPOSITION.no_change
        ? "The review found no supported change. The proposal remains blocked from Start pending conclusive evidence; recheck after relevant evidence changes."
        : "The review finished. Check the current offer for updated evidence; it remains offered until you accept or reject it."
  }
}

export const attemptedActions = (
  sql: SqlClient.SqlClient,
  runId: string
): Effect.Effect<boolean, SqlError> =>
  sql`SELECT 1 WHERE ${runChanged(sql, runId)}
    UNION ALL SELECT 1 FROM task_proposals WHERE source_run_id = ${runId}
      OR json_extract(retirement_json, '$.run_id') = ${runId}
    UNION ALL SELECT 1 FROM run_questions WHERE run_id = ${runId}
    UNION ALL SELECT 1 FROM space_task_events WHERE run_ref = ${runId} LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0)
  )

export const validateProposed = Effect.fn("SpaceReview.validateProposed")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  spaceId: string,
  proposalIds: ReadonlyArray<string>
) {
  const expected = [...new Set(proposalIds.map(canonicalProposalId))].sort()
  const proposals = yield* sql<{ readonly proposal_id: string }>`
    SELECT proposal_id FROM task_proposals
    WHERE (source_run_id = ${runId} OR json_extract(retirement_json, '$.run_id') = ${runId}) AND space_id = ${spaceId}
    ORDER BY proposal_id`
  const receipts = yield* sql<{
    readonly proposal_id: string | null
    readonly source_tool_call_id: string | null
    readonly tool_call_id: string
  }>`
    SELECT json_extract(receipt.result_json, '$.data.proposal.proposal_id') AS proposal_id,
      CASE WHEN json_extract(receipt.result_json, '$.data.decision') = 'retire'
        THEN json_extract(proposal.retirement_json, '$.tool_call_id')
        ELSE proposal.source_tool_call_id END AS source_tool_call_id, receipt.tool_call_id
    FROM tool_calls AS receipt
    LEFT JOIN task_proposals AS proposal
      ON proposal.proposal_id = json_extract(receipt.result_json, '$.data.proposal.proposal_id')
      AND (proposal.source_run_id = ${runId} OR json_extract(proposal.retirement_json, '$.run_id') = ${runId})
      AND proposal.space_id = ${spaceId}
    WHERE receipt.run_id = ${runId} AND receipt.changes_state = 1
      AND receipt.tool_name IN ('space_task_infer', 'task_propose') AND receipt.status = 'completed'
      AND COALESCE(json_extract(receipt.result_json, '$.is_error'), 1) = 0
      AND json_extract(receipt.result_json, '$.data.decision') IN ('propose', 'retire')
    ORDER BY proposal_id, receipt.tool_call_id`
  const questions = yield* sql`SELECT 1 FROM run_questions WHERE run_id = ${runId}
    AND resolution IS NULL AND closed_at IS NULL LIMIT 1`
  const persisted = proposals.map((proposal) => proposal.proposal_id)
  const malformedReceipt = receipts.some(
    (receipt) =>
      receipt.proposal_id === null || receipt.source_tool_call_id !== receipt.tool_call_id
  )
  const recorded = [...new Set(receipts.map((receipt) => receipt.proposal_id))]
  if (
    questions.length > 0 ||
    malformedReceipt ||
    JSON.stringify(persisted) !== JSON.stringify(recorded)
  )
    return yield* failure(
      "invalid",
      "Proposed result must reference the exact proposals authored by this Space review"
    )
  if (JSON.stringify(persisted) !== JSON.stringify(expected))
    return yield* failure(
      "conflict",
      persisted.length === 0
        ? "This Space review offered no Task proposals, so it cannot finish as proposed. Finish with the disposition that matches what this Run did."
        : `Proposed result must list exactly the proposals this Space review offered. Call space_review_finish again with proposal_ids ${JSON.stringify(persisted)}.`
    )
})
