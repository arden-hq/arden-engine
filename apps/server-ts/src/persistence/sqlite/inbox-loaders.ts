import { taskHasHold } from "./task-hold-state.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { failureRows } from "./inbox-failure-rows.js"
import { decodeRunApproval, type ApprovalRow } from "./run-approvals.js"
import { type CommentRow, type TaskRow } from "./inbox-blocked.js"
import { Effect } from "effect"
import { planLimitNoticeRows } from "./inbox-plan-limit.js"
import { SqlClient } from "effect/unstable/sql"
import { InboxStoreError, type OpenAsks } from "../inbox/store.js"
import type { RunApproval } from "@arden-hq/protocol/runs"
import { spokenDescription } from "./inbox-spoken.js"
import { makeRunQuestionReader, type QuestionRow } from "./run-question-read.js"
import { MAX_SCRIPT_RESULT_ATTEMPTS } from "../scripts/results.js"
import { type SpacePauseRow, type PauseRow } from "./inbox-failures.js"
import { taskOpenSql } from "./task-status-sql.js"
import {
  type SpaceRow,
  type AbandonedDeliveryRow,
  type IncidentRow,
  type ReadRow,
  type DismissRow,
  type Snapshot,
  type StoreOperation,
  type OpenAsksOperation,
  storeError,
  newestFirst,
  approvalKey,
  query
} from "./inbox-rows.js"

export type OpenAsksLoader = (
  operation: OpenAsksOperation
) => Effect.Effect<OpenAsks, InboxStoreError>

export const makeOpenAsksLoader = (sql: SqlClient.SqlClient): OpenAsksLoader => {
  const questionReader = makeRunQuestionReader(sql)
  return Effect.fn("SqliteInbox.loadOpenAsks")(function* (
    operation: OpenAsksOperation
  ): Effect.fn.Return<OpenAsks, InboxStoreError> {
    const questionRows = yield* query(
      operation,
      sql<QuestionRow>`SELECT * FROM (${questionReader.openSelect}) WHERE status = 'open'`
    )
    const questions = yield* Effect.forEach(questionRows, questionReader.decode).pipe(
      Effect.mapError((cause) =>
        storeError(operation, "storage", "Could not read Inbox questions", cause)
      )
    )
    const approvalRows = yield* query(
      operation,
      sql<ApprovalRow>`
      SELECT run_id, session_id, destination_session_id, work_json, tool_call_id, tool_name, action,
             scope, preview, diff, requested_at, kind, payload_json, source
      FROM (${pendingDecisionCards(sql)})
    `
    )
    const approvals = yield* Effect.forEach(approvalRows, (row) =>
      decodeRunApproval(row).pipe(
        Effect.mapError((cause) =>
          storeError(operation, "storage", "Stored Inbox approval payload is corrupt", cause)
        ),
        Effect.map((approval): RunApproval => ({
          ...approval,
          description: spokenDescription(approval.description)
        }))
      )
    )
    return {
      questions: newestFirst(
        questions,
        (question) => question.created_at,
        (question) => question.question_id
      ),
      approvals: newestFirst(approvals, (approval) => approval.at, approvalKey)
    }
  })
}

export type SnapshotLoader = (
  operation: StoreOperation,
  now: string,
  cutoff: string
) => Effect.Effect<Snapshot, InboxStoreError>

export const makeSnapshotLoader = (sql: SqlClient.SqlClient): SnapshotLoader => {
  const loadOpenAsks = makeOpenAsksLoader(sql)
  return Effect.fn("SqliteInbox.loadSnapshot")(function* (
    operation: StoreOperation,
    now: string,
    cutoff: string
  ): Effect.fn.Return<Snapshot, InboxStoreError> {
    const { questions, approvals } = yield* loadOpenAsks(operation)
    const spaces = yield* query(
      operation,
      sql<SpaceRow>`
      SELECT space_id, name
      FROM spaces
      WHERE archived_at IS NULL
    `
    )

    const tasks = yield* query(
      operation,
      sql<TaskRow>`
      SELECT item.item_id, item.space_id, item.stable_key, item.seq,
             item.text, item.waiting_on, item.updated_at
      FROM space_tasks AS item
      LEFT JOIN spaces AS space ON space.space_id = item.space_id
      WHERE (item.space_id IS NULL OR space.archived_at IS NULL)
        AND item.blocked = 1
        AND NOT ${taskHasHold(sql, sql`item`)}
        AND ${taskOpenSql("item")}
    `
    )

    const comments =
      tasks.length === 0
        ? []
        : yield* query(
            operation,
            sql<CommentRow>`
        SELECT item_id, body, created_at
        FROM (
          SELECT comment.item_id, comment.body, comment.created_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY comment.item_id
                   ORDER BY julianday(comment.created_at) DESC, comment.comment_id DESC
                 ) AS recency
          FROM space_task_comments AS comment
          JOIN space_tasks AS item
            ON item.item_id = comment.item_id
           AND item.blocked = 1
           AND ${taskOpenSql("item")}
          LEFT JOIN spaces AS space ON space.space_id = item.space_id
          -- Only an ask reaches the Inbox, and it reaches it AS the block, not
          -- as a comment, and never one the owner wrote themselves — the public
          -- comment contract permits a user-authored ask.
          -- A note or a result is workspace content: the ticket
          -- already renders the whole trail with a composer, and copying the
          -- latest one here moved a read row's timestamp and made it unread
          -- again for something nobody was asked about.
          WHERE comment.kind = 'ask' AND comment.author != 'user'
            AND (item.space_id IS NULL OR space.archived_at IS NULL)
        )
        WHERE recency = 1
      `
          )

    const failures = yield* query(operation, failureRows(sql, cutoff))

    const pauses = yield* query(
      operation,
      sql<PauseRow>`
      SELECT task_id, json_extract(payload, '$.attemptId') AS attempt_id,
        json_extract(payload, '$.resumedAt') IS NOT NULL AS resumed
      FROM automation_deliveries
      WHERE task_id IS NOT NULL AND json_extract(payload, '$.kind') = 'automation_paused'
    `
    )

    const spacePauses = yield* query(
      operation,
      sql<SpacePauseRow>`
      SELECT delivery_id, task_id, created_at FROM automation_deliveries
      WHERE task_id IS NOT NULL AND json_extract(payload, '$.kind') = 'automation_space_paused'
        AND json_extract(payload, '$.resumedAt') IS NULL
    `
    )

    const abandonedDeliveries = yield* query(
      operation,
      sql<AbandonedDeliveryRow>`
      SELECT json_extract(delivery.payload, '$.workflowRef') AS workflow_ref,
             json_extract(delivery.payload, '$.attempt') AS attempt,
             json_extract(delivery.payload, '$.originRunId') AS origin_run_id,
             session.space_id, session.name AS chat_name,
             delivery.last_error, delivery.created_at AS settled_at
      FROM automation_deliveries AS delivery
      JOIN sessions AS session
        ON session.session_id = json_extract(delivery.payload, '$.sessionId')
      WHERE delivery.status = 'pending'
        AND json_extract(delivery.payload, '$.kind') = 'script_result'
        AND delivery.attempt_count >= ${MAX_SCRIPT_RESULT_ATTEMPTS}
    `
    )

    const incidents = yield* query(
      operation,
      sql<IncidentRow>`
      SELECT incident_id, delivery_id, code, summary, source_run_id, created_at
      FROM delivery_incidents
    `
    )

    const marks = yield* query(
      operation,
      sql<ReadRow>`
      SELECT item_key, read_at
      FROM inbox_reads
    `
    )

    const dismissals = yield* query(
      operation,
      sql<DismissRow>`
      SELECT item_key, dismissed_at
      FROM inbox_dismissals
    `
    )

    const notices = yield* query(operation, planLimitNoticeRows(sql))

    return {
      now,
      spaces,
      tasks,
      comments,
      approvals,
      failures,
      pauses,
      spacePauses,
      abandonedDeliveries,
      incidents,
      marks,
      dismissals,
      questions,
      planLimitNotice: notices[0]?.state
    }
  })
}
