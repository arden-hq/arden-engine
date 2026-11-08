import { readChatSettled, settledFingerprint } from "./chat-ownership.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { readSpaceReviewContext } from "./space-job-context.js"
import { Clock, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { AutomationStoreError, type AutomationJobLeaseRef } from "../automations/store.js"
import { SpaceReviewStore } from "../automations/space-review-store.js"
import {
  canonicalDisposition,
  canonicalProposalId,
  SpaceReviewDispositionSchema,
  SpaceReviewInputSchema,
  type SpaceReviewItem
} from "../automations/space-review.js"
import { parseLease } from "./automation-lease.js"
import { QueueContextSchema } from "./automation-queue-context.js"
import { readGateEvidence } from "./space-review-gate-evidence.js"
import { decodeJson, encodeJson } from "./json.js"
import type { PersistenceDeps } from "./deps.js"
import { modelTurnRunStatusList, restartCutRunSql } from "./status-sets.js"
import { runChanged } from "./run-effects.js"
import { iso } from "../../runtime/clock.js"
import { enqueue } from "./automation-enqueue.js"
import { spaceJobId } from "../space-job-id.js"
import { userChatSql } from "./chat-ownership.js"
import { queuedEventType } from "./automation-listening.js"
import { RUNS_ALONE } from "../automations/event-batch.js"

const ITEM_REVIEW_DAYS = 14
const ITEM_REVIEW_LIMIT = 20

const failure = (reason: AutomationStoreError["reason"], message: string, cause?: unknown) =>
  new AutomationStoreError({
    operation: "space_review",
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const reviewRunState = (state: string): "completed" | "failed" | "running" => {
  switch (state) {
    case "running":
      return "running"
    case "failed":
    case "cancelled":
    case "interrupted":
      return "failed"
    default:
      return "completed"
  }
}

const reviewRunMessage = (
  state: "completed" | "failed" | "running",
  outcome: string | null
): string => {
  switch (state) {
    case "running":
      return "The Space is rechecking this offer."
    case "failed":
      return "The Space review failed. You can recheck this offer again."
    case "completed":
      return outcome === "no_change"
        ? "The review found no supported change. The proposal remains blocked from Start pending conclusive evidence; recheck after relevant evidence changes."
        : "The review finished. Check the current offer for updated evidence; it remains offered until you accept or reject it."
  }
}

const attemptedActions = (sql: SqlClient.SqlClient, runId: string) =>
  sql`SELECT 1 WHERE ${runChanged(sql, runId)}
    UNION ALL SELECT 1 FROM task_proposals WHERE source_run_id = ${runId}
      OR json_extract(retirement_json, '$.run_id') = ${runId}
    UNION ALL SELECT 1 FROM run_questions WHERE run_id = ${runId}
    UNION ALL SELECT 1 FROM space_task_events WHERE run_ref = ${runId} LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0)
  )

const validateProposed = Effect.fn("SpaceReview.validateProposed")(function* (
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

export const makeSpaceReviewStore = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "sessionEvents">): SpaceReviewStore["Service"] => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
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
          const jobs = yield* sql<{ readonly task_id: string }>`SELECT task_id FROM scheduled_tasks
            WHERE task_id = ${automationId} AND purpose = 'space_review' AND enabled = 1`
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
            trigger_context_snapshot: {
              source: "event" as const,
              queued_at: queuedAt,
              event_type: "space.proposal_review_requested",
              event_key: requestId,
              produced_by: null,
              context: {
                proposal_id: proposalId,
                expected_revision: expectedRevision,
                request_id: requestId
              }
            }
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
      FROM automation_event_queue AS queue JOIN scheduled_tasks AS task ON task.task_id = queue.task_id
      LEFT JOIN automation_runs AS run ON run.id = json_extract(queue.context, '$.automation_run_id')
      WHERE queue.task_id = ${automationId} AND task.purpose = 'space_review'
        AND ${queuedEventType(sql, sql`queue.context`)} = ${RUNS_ALONE}
        AND json_extract(queue.context, '$.trigger_context_snapshot.context.proposal_id') = ${proposalId}
      ORDER BY queue.id DESC LIMIT 1`
      if (queued[0] !== undefined) {
        const row = queued[0]
        const state: "queued" | "running" =
          row.claimed_at === null || row.run_status !== "running" ? "queued" : "running"
        return {
          expectedRevision: row.expected_revision,
          state,
          message:
            state === "queued"
              ? "The Space review is queued. The offer is not cleared to Start until its evidence is rechecked."
              : "The Space is rechecking this offer."
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
  const currentLease = Effect.fn("SpaceReview.currentLease")(function* (
    lease: AutomationJobLeaseRef
  ) {
    const parsed = parseLease(lease)
    const rows = yield* sql<{
      readonly context: string
      readonly space_id: string
      readonly prompt: string
    }>`
      SELECT queue.context, job.owner_space_id AS space_id, job.prompt FROM automation_event_queue AS queue
      JOIN scheduled_tasks AS job ON job.task_id = queue.task_id AND job.purpose = 'space_review'
      JOIN automation_runs AS attempt ON attempt.id = ${parsed.runId} AND attempt.task_id = queue.task_id
      WHERE queue.id = ${parsed.queueId} AND queue.task_id = ${lease.payload.automationId}
        AND queue.claimed_at IS NOT NULL AND attempt.claim_count = ${parsed.claimAttempt}
        AND queue.lease_expires_at > ${iso(yield* Clock.currentTimeMillis)} AND attempt.status = 'running'
        AND json_extract(queue.context, '$.automation_run_id') = attempt.id`
    if (!rows[0]) return yield* failure("conflict", "Space review lease is no longer current")
    return { ...rows[0], ...parsed }
  })

  const prepareSpaceReview: SpaceReviewStore["Service"]["prepareSpaceReview"] = Effect.fn(
    "SpaceReview.prepare"
  )(function* (lease, build) {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const current = yield* currentLease(lease)
          const context = yield* decodeJson(QueueContextSchema, current.context)
          if (context.space_review_input !== undefined) {
            if (context.space_review_input.admission !== "unchanged")
              return context.space_review_input
            if (lease.payload.proposalReviewTarget === undefined) return null
            const forced = { ...context.space_review_input, admission: "changed" as const }
            const encoded = yield* encodeJson(QueueContextSchema, {
              ...context,
              space_review_input: forced
            })
            const frozen = yield* encodeJson(SpaceReviewInputSchema, forced)
            yield* sql`UPDATE automation_event_queue SET context = ${encoded} WHERE id = ${current.queueId}`
            yield* sql`UPDATE automation_runs SET input_json = ${frozen} WHERE id = ${current.runId}`
            return forced
          }
          const spaces = yield* sql<{
            readonly page_id: string | null
            readonly page_path: string | null
            readonly inference: number | null
            readonly semantic: string
          }>`
        SELECT page_id, page_path, json_extract(inference_policy, '$.enabled') AS inference, json_object('name', name, 'instructions', instructions,
          'inference_policy', json(inference_policy), 'policy_generation', policy_generation,
          'page_id', page_id, 'page_path', page_path) AS semantic FROM spaces
        WHERE space_id = ${current.space_id} AND archived_at IS NULL`
          const space = spaces[0]
          if (!space) return yield* failure("conflict", "The Space is archived or unavailable")
          const sources = yield* sql<{
            readonly source: string
          }>`SELECT source FROM space_task_sources
        JOIN space_tasks USING(item_id) WHERE space_id = ${current.space_id} ORDER BY item_id, source_key`
          const memorySources = yield* sql<{
            readonly page_ref: string
          }>`SELECT DISTINCT json_extract(source, '$.page_ref') AS page_ref
        FROM space_task_sources JOIN space_tasks USING(item_id) WHERE space_id = ${current.space_id}
          AND json_extract(source, '$.kind') = 'memory' ORDER BY page_ref`
          const tasks = yield* sql<{
            readonly semantic: string
          }>`SELECT json_object('item_id', item_id, 'text', text,
        'body', body, 'status', status, 'owner', owner, 'blocked', blocked, 'waiting_on', waiting_on,
        'due_at', due_at, 'next_attempt_at', next_attempt_at) AS semantic
        FROM space_tasks WHERE space_id = ${current.space_id} ORDER BY item_id`
          const chats = yield* sql<{
            readonly sessionId: string
            readonly sessionRef: string
            readonly runId: string
            readonly turnId: string
          }>`
        SELECT session.session_id AS "sessionId", session.public_ref AS "sessionRef", run.run_id AS "runId",
          json_extract(run.metadata_json, '$.turn_id') AS "turnId"
        FROM sessions AS session JOIN chat_runs AS run ON run.session_id = session.session_id
        JOIN chat_idempotency_keys AS request ON request.run_id = run.run_id AND request.client_id = run.client_id
        WHERE ${userChatSql("session")} AND session.archived_at IS NULL
          AND (session.space_id = ${current.space_id} OR EXISTS (SELECT 1 FROM space_task_sources AS source
            JOIN space_tasks AS task ON task.item_id = source.item_id WHERE task.space_id = ${current.space_id}
              AND json_extract(source.source, '$.kind') = 'chat'
              AND json_extract(source.source, '$.session_id') = session.session_id)
            OR EXISTS (SELECT 1 FROM space_chat_links AS link WHERE link.space_id = ${current.space_id}
              AND link.session_id = session.session_id AND link.run_id = run.run_id))
          AND run.status = 'completed' AND json_extract(request.message_json, '$.is_meta') IS NOT 1
          AND json_extract(run.metadata_json, '$.automation') IS NULL
          AND json_extract(run.metadata_json, '$.turn_id') IS NOT NULL
        ORDER BY session.session_id, run.started_at, run.run_id`
          const routedSince = iso((yield* Clock.currentTimeMillis) - ITEM_REVIEW_DAYS * 86_400_000)
          const items =
            space.inference === 1
              ? yield* sql<SpaceReviewItem>`SELECT item.item_id AS "itemId", item.source,
                  item.sender, item.title, item.snippet, item.received_at AS "receivedAt",
                  item.route_reason AS reason
                FROM connection_items AS item
                WHERE item.owner_space_id = ${current.space_id} AND item.state = 'routed'
                  AND item.routed_at >= ${routedSince}
                  AND NOT EXISTS (SELECT 1 FROM task_proposals AS proposal,
                    json_each(proposal.sources_json) AS cited
                    WHERE json_extract(cited.value, '$.kind') = 'connection_item'
                      AND json_extract(cited.value, '$.item_id') = item.item_id)
                ORDER BY item.routed_at DESC, item.item_id LIMIT ${ITEM_REVIEW_LIMIT}`
              : []
          const offers = yield* sql<{ readonly text: string }>`SELECT text FROM task_proposals
            WHERE space_id = ${current.space_id} AND status = 'offered' ORDER BY created_at, proposal_id`
          const previous = yield* sql<{
            readonly reviewed_input: string
          }>`SELECT reviewed_input FROM space_review_checkpoints WHERE space_id = ${current.space_id}`
          const reviewed =
            previous[0] === undefined
              ? undefined
              : yield* decodeJson(SpaceReviewInputSchema, previous[0].reviewed_input)
          const settled = settledFingerprint(yield* readChatSettled(sql, current.space_id))
          const built = build({
            spaceId: current.space_id,
            pageId: space.page_id,
            pagePath: space.page_path,
            memorySources: memorySources.map((source) => source.page_ref),
            semantic: JSON.stringify({
              space: space.semantic,
              settled,
              tasks: tasks.map((task) => task.semantic),
              sources: sources.map((source) => source.source)
            }),
            chats,
            items,
            openProposals: offers.map((offer) => offer.text),
            space: yield* readSpaceReviewContext(sql, current.space_id),
            ...(reviewed === undefined ? {} : { reviewed })
          })
          const input =
            built.admission === "unchanged" && lease.payload.proposalReviewTarget !== undefined
              ? { ...built, admission: "changed" as const }
              : built
          const encoded = yield* encodeJson(QueueContextSchema, {
            ...context,
            space_review_input: input
          })
          yield* sql`UPDATE automation_event_queue SET context = ${encoded} WHERE id = ${current.queueId}`
          const frozen = yield* encodeJson(SpaceReviewInputSchema, input)
          yield* sql`UPDATE automation_runs SET input_json = ${frozen} WHERE id = ${current.runId} AND input_json IS NULL`
          return input.admission === "unchanged" ? null : input
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : failure("storage", "Could not prepare Space review", cause)
        )
      )
  })

  const readSpaceReviewGateEvidence: SpaceReviewStore["Service"]["readSpaceReviewGateEvidence"] = (
    lease,
    changedTurns
  ) =>
    readGateEvidence(
      sql,
      { runId: parseLease(lease).runId, automationId: lease.payload.automationId },
      changedTurns
    ).pipe(
      Effect.mapError((cause) =>
        failure("storage", "Could not read the Space review gate evidence", cause)
      )
    )

  const holdSpaceReview: SpaceReviewStore["Service"]["holdSpaceReview"] = Effect.fn(
    "SpaceReview.hold"
  )(function* (lease, until) {
    const now = iso(yield* Clock.currentTimeMillis)
    yield* writer
      .transact(
        Effect.gen(function* () {
          yield* currentLease(lease)
          yield* spaceJobs.holdReview(lease.payload.automationId, now, until)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : failure("storage", "Could not hold the Space review", cause)
        )
      )
  })

  const validateSpaceReviewDisposition: SpaceReviewStore["Service"]["validateSpaceReviewDisposition"] =
    Effect.fn("SpaceReview.validateDisposition")(function* (runId, disposition) {
      const valid = yield* Schema.decodeUnknownEffect(SpaceReviewDispositionSchema)(
        disposition
      ).pipe(
        Effect.map(canonicalDisposition),
        Effect.mapError((cause) =>
          failure("invalid", "Space review requires a valid terminal disposition", cause)
        )
      )
      yield* writer
        .transact(
          Effect.gen(function* () {
            const runs = yield* sql<{
              readonly space_id: string
            }>`SELECT job.owner_space_id AS space_id FROM chat_runs AS run
        JOIN scheduled_tasks AS job ON job.task_id = json_extract(run.metadata_json, '$.automation.task_id')
        WHERE run.run_id = ${runId} AND run.status IN ${modelTurnRunStatusList} AND job.purpose = 'space_review'`
            if (!runs[0])
              return yield* failure(
                "conflict",
                "Only an active Space review can report its disposition"
              )
            if (valid.kind === "no_change") {
              if (yield* attemptedActions(sql, runId))
                return yield* failure(
                  "invalid",
                  "No change cannot hide attempted mutations or questions"
                )
            } else if (valid.kind === "changed") {
              for (const itemId of valid.task_ids) {
                const task =
                  yield* sql`SELECT 1 FROM space_tasks AS task WHERE task.item_id = ${itemId} AND task.space_id = ${runs[0].space_id} AND task.status != 'cancelled'
            AND (EXISTS (SELECT 1 FROM space_task_events AS event WHERE event.item_id = task.item_id AND event.run_ref = ${runId})
              OR EXISTS (SELECT 1 FROM tool_calls AS receipt JOIN space_task_comments AS comment
                ON comment.comment_id = json_extract(receipt.result_json, '$.data.comment.comment_id') AND comment.item_id = task.item_id
                WHERE receipt.run_id = ${runId} AND receipt.tool_name IN ('space_task_comment', 'task_comment')
                  AND receipt.status = 'completed' AND json_extract(receipt.result_json, '$.is_error') = 0)
              OR EXISTS (SELECT 1 FROM tool_calls AS receipt JOIN space_task_attachments AS attachment
                ON attachment.attachment_id = json_extract(receipt.result_json, '$.data.attachment_id') AND attachment.item_id = task.item_id
                WHERE receipt.run_id = ${runId} AND receipt.tool_name IN ('space_task_save_result', 'task_save_result')
                  AND receipt.status = 'completed' AND json_extract(receipt.result_json, '$.is_error') = 0))`
                if (task.length === 0)
                  return yield* failure(
                    "invalid",
                    "Changed result must reference a Task with a recorded change from this Run"
                  )
              }
              const actions =
                yield* sql`SELECT 1 FROM tool_calls WHERE run_id = ${runId} AND changes_state = 1
          AND status = 'completed' AND json_extract(result_json, '$.is_error') = 0 LIMIT 1`
              if (actions.length === 0)
                return yield* failure(
                  "invalid",
                  "Changed result requires a successful recorded action"
                )
            } else if (valid.kind === "proposed" || valid.kind === "reconciled") {
              yield* validateProposed(sql, runId, runs[0].space_id, valid.proposal_ids)
            } else {
              for (const questionId of valid.question_ids) {
                const question =
                  yield* sql`SELECT 1 FROM run_questions WHERE question_id = ${questionId}
            AND run_id = ${runId} AND resolution IS NULL AND closed_at IS NULL`
                if (question.length === 0)
                  return yield* failure(
                    "invalid",
                    "Needs user must reference an active question from this Run"
                  )
              }
            }
            const encoded = yield* encodeJson(SpaceReviewDispositionSchema, valid)
            yield* sql`UPDATE chat_runs SET metadata_json = json_set(metadata_json, '$.space_review_disposition', json(${encoded})) WHERE run_id = ${runId}`
            if (valid.kind === "no_change")
              yield* sql`UPDATE chat_runs SET metadata_json = json_set(metadata_json, '$.no_change_reason', ${valid.summary}) WHERE run_id = ${runId}`
            else
              yield* sql`UPDATE chat_runs SET metadata_json = json_remove(metadata_json, '$.no_change_reason') WHERE run_id = ${runId}`
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof AutomationStoreError
              ? cause
              : failure("storage", "Could not validate Space review disposition", cause)
          )
        )
    })

  const completeSpaceReview: SpaceReviewStore["Service"]["completeSpaceReview"] = Effect.fn(
    "SpaceReview.complete"
  )(function* (lease, runId) {
    const reviewedAt = iso(yield* Clock.currentTimeMillis)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const current = yield* currentLease(lease)
          const context = yield* decodeJson(QueueContextSchema, current.context)
          if (!context.space_review_input)
            return yield* failure("conflict", "Space review has no frozen input")
          const rows = yield* sql<{
            readonly disposition: string
          }>`SELECT json_extract(metadata_json, '$.space_review_disposition') AS disposition
        FROM chat_runs WHERE run_id = ${runId} AND status = 'completed'
          AND EXISTS (SELECT 1 FROM automation_runs WHERE id = ${current.runId} AND chat_run_id = ${runId})`
          if (!rows[0]?.disposition)
            return yield* failure("invalid", "Space review has no validated successful result")
          const disposition = yield* decodeJson(SpaceReviewDispositionSchema, rows[0].disposition)
          if (disposition.kind === "no_change") {
            if (yield* attemptedActions(sql, runId))
              return yield* failure("conflict", "Actions followed the no-change disposition")
          } else if (disposition.kind === "proposed" || disposition.kind === "reconciled") {
            yield* validateProposed(sql, runId, current.space_id, disposition.proposal_ids)
          }
          const input = yield* encodeJson(SpaceReviewInputSchema, context.space_review_input)
          yield* sql`INSERT INTO space_review_checkpoints(space_id, reviewed_input, run_id, reviewed_at)
        VALUES(${current.space_id}, ${input}, ${runId}, ${reviewedAt})
        ON CONFLICT(space_id) DO UPDATE SET reviewed_input = excluded.reviewed_input, run_id = excluded.run_id, reviewed_at = excluded.reviewed_at`
          return disposition
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : failure("storage", "Could not save Space review checkpoint", cause)
        )
      )
  })
  return SpaceReviewStore.of({
    prepareSpaceReview,
    readSpaceReviewGateEvidence,
    holdSpaceReview,
    validateSpaceReviewDisposition,
    completeSpaceReview,
    requestProposalReview,
    proposalReviewStatus
  })
}
