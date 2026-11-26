import { AUTOMATION_RUN_STATUS } from "@arden-hq/protocol/automations"
import { eventCauseOf } from "../automations/event-cause.js"
import { Clock, Effect } from "effect"
import { AutomationStoreError } from "../automations/store.js"
import { SpaceReviewStore } from "../automations/space-review-store.js"
import type { PersistenceDeps } from "./deps.js"
import { restartCutRunSql } from "./status-sets.js"
import { iso } from "../../runtime/clock.js"
import { enqueue } from "./automation-enqueue.js"
import { spaceJobId } from "../space-job-id.js"
import { queuedEventType } from "./automation-listening.js"
import { RUNS_ALONE } from "../automations/event-batch.js"
import { reviewMayRunSql } from "./automation-rows.js"
import { failure, reviewRunState, reviewRunMessage } from "./space-review-support.js"

export interface ProposalReviews {
  readonly requestProposalReview: SpaceReviewStore["Service"]["requestProposalReview"]
  readonly proposalReviewStatus: SpaceReviewStore["Service"]["proposalReviewStatus"]
}

export const makeProposalReviews = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "sessionEvents">): ProposalReviews => {
  const sql = writer.sql
  const proposalReviewRequestId = (proposalId: string, revision: number) =>
    `proposal-review:${proposalId}:${revision}`

  const requestProposalReview: SpaceReviewStore["Service"]["requestProposalReview"] = Effect.fn(
    "SpaceReview.requestProposalReview"
  )(function* ({ proposalId, expectedRevision }) {
    const now = yield* Clock.currentTimeMillis
    yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly space_id: string | null
            readonly space_exists: number
            readonly archived_at: string | null
          }>`SELECT proposal.space_id, space.space_id IS NOT NULL AS space_exists,
              space.archived_at
            FROM task_proposals AS proposal
            LEFT JOIN spaces AS space ON space.space_id = proposal.space_id
            WHERE proposal.proposal_id = ${proposalId} AND proposal.status = 'offered'
              AND proposal.revision = ${expectedRevision}`
          const offer = rows[0]
          if (offer === undefined)
            return yield* failure("conflict", "The Task proposal changed or is no longer offered")
          const spaceId = offer.space_id
          if (spaceId === null || spaceId === undefined)
            return yield* failure("conflict", "The Task proposal changed or is no longer offered")
          if (offer.space_exists !== 1 || offer.archived_at !== null)
            return yield* failure("conflict", "The Space is archived or unavailable")
          const automationId = spaceJobId(spaceId)
          const jobs = yield* sql`SELECT 1 FROM spaces AS space
            WHERE space.space_id = ${spaceId} AND ${reviewMayRunSql(sql, "space")}`
          if (jobs.length === 0)
            return yield* failure("conflict", "The Space review is off or unavailable")
          const requestId = proposalReviewRequestId(proposalId, expectedRevision)
          const active = yield* sql<{ readonly id: number }>`SELECT queue.id
            FROM automation_event_queue AS queue
            WHERE queue.task_id = ${automationId}
              AND EXISTS (SELECT 1 FROM json_tree(queue.context) AS target
                WHERE target.key = 'request_id' AND target.value = ${requestId})
              AND (json_extract(queue.context, '$.automation_run_id') IS NULL OR EXISTS (
                SELECT 1 FROM automation_runs AS run
                WHERE run.id = json_extract(queue.context, '$.automation_run_id')
                  AND run.status = 'running'))
            ORDER BY queue.id DESC LIMIT 1`
          if (active.length > 0) return
          const queuedAt = iso(now)
          const context = {
            scheduled_for: null,
            automation_run_id: null,
            trigger_context: `The person explicitly asked to recheck proposal ${proposalId} at revision ${expectedRevision}.`,
            trigger_context_snapshot: eventCauseOf({
              queued_at: queuedAt,
              event_type: "space.proposal_review_requested",
              event_key: requestId,
              produced_by: null,
              context: {
                proposal_id: proposalId,
                expected_revision: expectedRevision,
                request_id: requestId
              }
            })
          }
          yield* enqueue(
            { sql, sessionEvents },
            {
              automationId,
              source: "manual",
              key: requestId,
              context,
              dueAt: now,
              pending: "add"
            }
          )
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : failure("storage", "Could not queue the Task proposal recheck", cause)
        )
      )
  })

  const proposalReviewStatus: SpaceReviewStore["Service"]["proposalReviewStatus"] = Effect.fn(
    "SpaceReview.proposalReviewStatus"
  )(
    function* ({ proposalId }) {
      const proposalRows = yield* sql<{ readonly space_id: string | null }>`SELECT space_id
      FROM task_proposals WHERE proposal_id = ${proposalId}`
      const spaceId = proposalRows[0]?.space_id
      if (spaceId === null || spaceId === undefined) return undefined
      const automationId = spaceJobId(spaceId)
      const queued = yield* sql<{
        readonly expected_revision: number
        readonly claimed_at: string | null
        readonly run_status: string | null
      }>`SELECT json_extract(queue.context, '$.trigger_context_snapshot.context.expected_revision') AS expected_revision,
        queue.claimed_at, run.status AS run_status
      FROM automation_event_queue AS queue
      LEFT JOIN automation_runs AS run ON run.id = json_extract(queue.context, '$.automation_run_id')
      WHERE queue.task_id = ${automationId}
        AND ${queuedEventType(sql, sql`queue.context`)} = ${RUNS_ALONE}
        AND json_extract(queue.context, '$.trigger_context_snapshot.context.proposal_id') = ${proposalId}
      ORDER BY queue.id DESC LIMIT 1`
      if (queued[0] !== undefined) {
        const row = queued[0]
        const pending = row.claimed_at === null || row.run_status !== AUTOMATION_RUN_STATUS.running
        return {
          expectedRevision: row.expected_revision,
          ...(pending
            ? {
                state: "queued" as const,
                message:
                  "The Space review is queued. The offer is not cleared to Start until its evidence is rechecked."
              }
            : {
                state: AUTOMATION_RUN_STATUS.running,
                message: "The Space is rechecking this offer."
              })
        }
      }
      const rows = yield* sql<{
        readonly expected_revision: number
        readonly state: string
        readonly outcome: string | null
        readonly restart_cut: number
      }>`SELECT json_extract(run.trigger_json, '$.context.expected_revision') AS expected_revision,
        run.status AS state, run.outcome, COALESCE(${restartCutRunSql("chat")}, 0) AS restart_cut
      FROM automation_runs AS run
      LEFT JOIN chat_runs AS chat ON chat.run_id = run.chat_run_id
      WHERE run.task_id = ${automationId} AND run.purpose = 'space_review'
        AND json_extract(run.trigger_json, '$.event_type') = 'space.proposal_review_requested'
        AND json_extract(run.trigger_json, '$.context.proposal_id') = ${proposalId}
      ORDER BY run.id DESC LIMIT 1`
      const latest = rows[0]
      if (latest !== undefined) {
        const revision = latest.expected_revision
        const state = reviewRunState(latest.state)
        const message =
          latest.restart_cut === 1
            ? "A restart interrupted the Space review. You can recheck this offer again."
            : reviewRunMessage(state, latest.outcome)
        if (typeof revision === "number") return { expectedRevision: revision, state, message }
      }
      return undefined
    },
    (self) =>
      self.pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : failure("storage", "Could not read the Task proposal recheck", cause)
        )
      )
  )
  return { requestProposalReview, proposalReviewStatus }
}
