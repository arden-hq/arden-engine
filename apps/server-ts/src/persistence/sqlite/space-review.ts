import { SPACE_REVIEW_DISPOSITION } from "../automations/space-review.js"
import { writtenByPersonSql } from "./person-written-sql.js"
import { readChatSettled, settledFingerprint } from "./chat-ownership.js"
import { readSpaceReviewContext } from "./space-job-context.js"
import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { Clock, Effect, Schema } from "effect"
import { AutomationStoreError, type AutomationJobLeaseRef } from "../automations/store.js"
import { SpaceReviewStore } from "../automations/space-review-store.js"
import {
  askedByOwner,
  canonicalDisposition,
  SpaceReviewDispositionSchema,
  SpaceReviewInputSchema
} from "../automations/space-review.js"
import { parseLease } from "./automation-lease.js"
import { QueueContextSchema } from "./automation-queue-context.js"
import { decodeJson, encodeJson } from "./json.js"
import type { PersistenceDeps } from "./deps.js"
import { modelTurnRunStatusList } from "./status-sets.js"
import { iso } from "../../runtime/clock.js"
import { userChatSql } from "./chat-ownership.js"
import { keyMessageJson } from "./chat-key-message.js"
import { reviewSpaceIdSql } from "./automation-owner.js"
import { makeProposalReviews } from "./space-review-proposals.js"
import {
  REVIEWED_TASK_COLUMNS,
  attemptedActions,
  failure,
  validateProposed
} from "./space-review-support.js"

export const makeSpaceReviewStore = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "sessionEvents">): SpaceReviewStore["Service"] => {
  const sql = writer.sql
  const { requestProposalReview, proposalReviewStatus } = makeProposalReviews({
    writer,
    sessionEvents
  })
  const currentLease = Effect.fn("SpaceReview.currentLease")(function* (
    lease: AutomationJobLeaseRef
  ) {
    const parsed = parseLease(lease)
    const rows = yield* sql<{
      readonly context: string
      readonly space_id: string
      readonly trigger_json: string | null
    }>`
      SELECT queue.context, review_space.space_id, attempt.trigger_json FROM automation_event_queue AS queue
      JOIN spaces AS review_space ON review_space.space_id = ${reviewSpaceIdSql(sql, sql`queue.task_id`)}
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
          if (context.space_review_input !== undefined) return context.space_review_input
          const spaces = yield* sql<{
            readonly page_id: string | null
            readonly page_path: string | null
            readonly semantic: string
          }>`
        SELECT page_id, page_path, json_object('name', name, 'instructions', instructions,
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
          }>`SELECT json_object('item_id', item_id, ${sql.literal(REVIEWED_TASK_COLUMNS)}) AS semantic
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
          AND run.status = 'completed' AND ${writtenByPersonSql(sql, keyMessageJson(sql, "request"))}
          AND json_extract(run.metadata_json, '$.automation') IS NULL
          AND json_extract(run.metadata_json, '$.turn_id') IS NOT NULL
        ORDER BY session.session_id, run.started_at, run.run_id`
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
          const input = build({
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
            openProposals: offers.map((offer) => offer.text),
            space: yield* readSpaceReviewContext(sql, current.space_id),
            ...(reviewed === undefined ? {} : { reviewed }),
            asked:
              current.trigger_json !== null &&
              askedByOwner(yield* decodeJson(AutomationTriggerContextSchema, current.trigger_json))
          })
          const encoded = yield* encodeJson(QueueContextSchema, {
            ...context,
            space_review_input: input
          })
          yield* sql`UPDATE automation_event_queue SET context = ${encoded} WHERE id = ${current.queueId}`
          const frozen = yield* encodeJson(SpaceReviewInputSchema, input)
          yield* sql`UPDATE automation_runs SET input_json = ${frozen} WHERE id = ${current.runId} AND input_json IS NULL`
          return input
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
            }>`SELECT review_space.space_id FROM chat_runs AS run
        JOIN spaces AS review_space
          ON substr(json_extract(run.metadata_json, '$.automation.task_id'), 1, 6) = 'space:'
            AND review_space.space_id = substr(json_extract(run.metadata_json, '$.automation.task_id'), 7)
        WHERE run.run_id = ${runId} AND run.status IN ${modelTurnRunStatusList}`
            if (!runs[0])
              return yield* failure(
                "conflict",
                "Only an active Space review can report its disposition"
              )
            if (valid.kind === SPACE_REVIEW_DISPOSITION.no_change) {
              if (yield* attemptedActions(sql, runId))
                return yield* failure(
                  "invalid",
                  "No change cannot hide attempted mutations or questions"
                )
            } else if (valid.kind === SPACE_REVIEW_DISPOSITION.changed) {
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
            } else if (
              valid.kind === SPACE_REVIEW_DISPOSITION.proposed ||
              valid.kind === SPACE_REVIEW_DISPOSITION.reconciled
            ) {
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
            if (valid.kind === SPACE_REVIEW_DISPOSITION.no_change)
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
          if (disposition.kind === SPACE_REVIEW_DISPOSITION.no_change) {
            if (yield* attemptedActions(sql, runId))
              return yield* failure("conflict", "Actions followed the no-change disposition")
          } else if (
            disposition.kind === SPACE_REVIEW_DISPOSITION.proposed ||
            disposition.kind === SPACE_REVIEW_DISPOSITION.reconciled
          ) {
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
  const reviewReads: SpaceReviewStore["Service"]["reviewReads"] = Effect.fn(
    "SpaceReview.reviewReads"
  )(
    function* (runId) {
      const rows = yield* sql<{ readonly input: string | null }>`SELECT attempt.input_json AS input
        FROM automation_runs AS attempt
        WHERE attempt.chat_run_id = ${runId} AND attempt.purpose = 'space_review'
          AND attempt.status = 'running'`
      const input = rows[0]?.input
      if (input === null || input === undefined) return undefined
      return (yield* decodeJson(SpaceReviewInputSchema, input)).reads
    },
    (self) =>
      self.pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : failure("storage", "Could not read what the Space review covers", cause)
        )
      )
  )
  return SpaceReviewStore.of({
    prepareSpaceReview,
    validateSpaceReviewDisposition,
    completeSpaceReview,
    requestProposalReview,
    proposalReviewStatus,
    reviewReads
  })
}
