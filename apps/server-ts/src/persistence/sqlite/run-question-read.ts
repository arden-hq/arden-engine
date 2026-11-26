import { StoredRunQuestionContentSchema, type StoredRunQuestion } from "../runs/stored-question.js"
import { RunContextSchema } from "../runs/stored-context.js"
import { StoredRunQuestionSchema } from "../runs/stored-question.js"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { journalRecordsSql } from "@arden-hq/journal/effect"
import type { WorkStore, WorkStoreError } from "../work/store.js"
import {
  RUN_PAGE,
  RUN_PAGE_NEXT,
  RUN_QUESTION_FILTER,
  RUN_QUESTION_STATE,
  type RunQuestionFilter
} from "@arden-hq/protocol/runs"
import type { Fragment, Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"
import { SESSION_LIFECYCLE_STREAM_ID } from "../sessions/events.js"
import { decodeJson } from "./json.js"
import { questionVisiblePredicate } from "./question-events.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { workError } from "./work-records.js"
import { ruleSavedInSql } from "./permissions.js"
import { decodeOpaque, encodeOpaque } from "../../lib/opaque-ref.js"

export interface QuestionRow {
  readonly question_id: string
  readonly run_id: string
  readonly turn_id: string
  readonly session_id: string
  readonly content: string
  readonly context: string
  readonly resolution: string | null
  readonly continuation: string | null
  readonly focus_choice: string | null
  readonly permission_offer: string | null
  readonly continuity_revision: number | null
  readonly destination_session_id: string
  readonly created_at: string
  readonly status: string
  readonly timer: string | null
  readonly contract_proposal: string | null
  readonly source_title: string | null
}
const CursorSchema = Schema.Struct({ at: Schema.String, id: Schema.String })

export interface RunQuestionReader {
  readonly get: (id: string) => Effect.Effect<StoredRunQuestion, WorkStoreError>
  readonly questions: WorkStore["Service"]["questions"]
  readonly select: Statement<Row>
  readonly openSelect: Statement<Row>
  readonly decode: (row: QuestionRow) => Effect.Effect<StoredRunQuestion, WorkStoreError>
}

export const makeRunQuestionReader = (sql: SqlClient.SqlClient): RunQuestionReader => {
  const decode = Effect.fn(
    function* (row: QuestionRow) {
      const context = yield* decodeJson(RunContextSchema, row.context)
      const content = yield* decodeJson(StoredRunQuestionContentSchema, row.content)
      const resolution =
        row.resolution === null ? null : yield* decodeJson(Schema.Json, row.resolution)
      const continuation =
        row.continuation === null ? null : yield* decodeJson(Schema.Json, row.continuation)
      const focusChoice =
        row.focus_choice === null ? null : yield* decodeJson(Schema.Json, row.focus_choice)
      const {
        permission_offer: offer,
        timer: encodedTimer,
        contract_proposal: encodedProposal,
        source_title: sourceTitle,
        ...fields
      } = row
      const timer = encodedTimer === null ? undefined : yield* decodeJson(Schema.Json, encodedTimer)
      const contractProposal =
        encodedProposal === null ? undefined : yield* decodeJson(Schema.Json, encodedProposal)
      const permissionOffer = offer === null ? null : yield* decodeJson(Schema.Json, offer)
      return yield* Schema.decodeUnknownEffect(StoredRunQuestionSchema)({
        ...fields,
        permission_offer: permissionOffer,
        context,
        content,
        resolution,
        continuation,
        focus_choice: focusChoice,
        ...(timer === undefined ? {} : { timer }),
        ...(contractProposal === undefined ? {} : { contract_proposal: contractProposal }),
        ...(sourceTitle === null ? {} : { source_title: sourceTitle })
      })
    },
    Effect.mapError((cause) => workError("storage", "Stored Run question is corrupt", cause))
  )

  const destinationSessionId = runDestinationSessionId(sql, runColumns(sql, "r"))
  const select = sql`SELECT q.question_id, q.run_id, json_extract(r.metadata_json, '$.turn_id') AS turn_id, r.session_id, q.content, q.resolution, q.created_at,
    json_extract(r.metadata_json, '$.run_context') AS context,
    CASE WHEN focus_choice.choice_id IS NULL THEN NULL ELSE json_object(
      'space_id', focus_choice.space_id,
      'revision', focus_choice.revision,
      'status', focus_choice.status
    ) END AS focus_choice,
    CASE WHEN permission_offer.question_id IS NULL THEN NULL
      -- Only a rule this tap wrote says where it went: a tap that changed nothing, or a
      -- rule since removed, says nothing.
      ELSE json_object('tool_name', permission_offer.tool_name, 'saved_in', json((
        SELECT ${ruleSavedInSql(sql, { kind: sql`rule.list_kind`, spaceId: sql`rule.space_id` })}
        FROM permission_rules AS rule
        WHERE rule.source_question_id = permission_offer.question_id LIMIT 1))) END AS permission_offer,
    CASE WHEN timer.question_id IS NULL THEN NULL ELSE json_object(
      'expires_at', timer.expires_at, 'seconds', timer.seconds,
      'fallback_choice_id', timer.fallback_choice_id, 'status', timer.status
    ) END AS timer,
    CASE WHEN proposal.question_id IS NULL THEN NULL ELSE json_object(
      'item_id', proposal.item_id,
      'task', COALESCE(proposal_task.text, ''),
      'change', CASE
        WHEN json_extract(proposal.change_json, '$.kind') = 'retire' THEN 'remove'
        WHEN json_extract(proposal.change_json, '$.replaces') IS NOT NULL THEN 'replace'
        ELSE 'add' END,
      'line', COALESCE(CASE WHEN json_extract(proposal.change_json, '$.kind') = 'retire'
        THEN (SELECT retired.text FROM task_contract_lines AS retired
          WHERE retired.line_id = json_extract(proposal.change_json, '$.line_id'))
        ELSE json_extract(proposal.change_json, '$.line.text') END, '')
    ) END AS contract_proposal,
    COALESCE(${destinationSessionId}, r.session_id) AS destination_session_id,
    -- The chat that asked, by name: a run copy has none, so its parent's.
    COALESCE(NULLIF(trim(asking.name), ''), NULLIF(trim(asking_parent.name), '')) AS source_title,
    CASE WHEN json_extract(question_change.data_json, '$.session_id') IS ${destinationSessionId}
      THEN question_change.sequence ELSE NULL END AS continuity_revision,
    CASE
      WHEN delivery.status = 'pending' THEN json_object('kind', 'queued')
      -- Delivered into the asking run itself: the answer steered that run. Its
      -- receipt says whether the run has read it yet.
      WHEN delivery.status = 'delivered' AND substr(json_extract(delivery.destinations, '$[0]'), 6) = q.run_id
        AND answer_receipt.status = 'queued'
        THEN json_object('kind', 'steering', 'run_id', q.run_id)
      WHEN delivery.status = 'delivered' AND substr(json_extract(delivery.destinations, '$[0]'), 6) = q.run_id
        THEN json_object('kind', 'steered', 'run_id', q.run_id, 'at', COALESCE(answer_receipt.updated_at, delivery.delivered_at))
      WHEN delivery.status = 'delivered' THEN json_object('kind', 'started', 'run_id', substr(json_extract(delivery.destinations, '$[0]'), 6), 'at', delivery.delivered_at)
      WHEN delivery.status = 'discarded' THEN json_object('kind', 'withdrawn', 'reason', json_extract(delivery.payload, '$.withdrawal.reason'), 'at', json_extract(delivery.payload, '$.withdrawal.at'))
      ELSE NULL END AS continuation,
    CASE WHEN q.resolution IS NOT NULL THEN 'resolved'
      WHEN q.closed_at IS NOT NULL THEN 'closed'
      WHEN json_extract(r.metadata_json, '$.run_context.task.item_id') IS NOT NULL
        AND task.generation IS NOT json_extract(r.metadata_json, '$.run_context.task.generation') THEN 'closed'
      WHEN task.status = 'deferred' THEN 'suspended'
      WHEN NOT (${questionVisiblePredicate({
        sql,
        run: runColumns(sql, "r"),
        resolution: sql`q.resolution`,
        closedAt: sql`q.closed_at`
      })}) THEN 'closed'
      ELSE 'open' END AS status
    FROM run_questions AS q JOIN chat_runs AS r ON r.run_id = q.run_id
    -- The unary + on q.question_id here and below drops its TEXT affinity, so the
    -- comparison matches the expression index and each question is one lookup.
    LEFT JOIN automation_deliveries AS delivery ON json_extract(delivery.payload, '$.questionId') = +q.question_id
      AND json_extract(delivery.payload, '$.kind') = 'answer'
    LEFT JOIN chat_idempotency_keys AS answer_receipt
      ON answer_receipt.session_id = json_extract(delivery.payload, '$.sessionId')
      AND answer_receipt.client_id = delivery.message_id
    LEFT JOIN sessions AS asking ON asking.session_id = COALESCE(
      json_extract(r.metadata_json, '$.run_context.origin.session_id'), r.session_id)
    LEFT JOIN sessions AS asking_parent ON asking_parent.session_id = asking.parent_session_id
    LEFT JOIN focus_choices AS focus_choice ON focus_choice.question_id = q.question_id
    LEFT JOIN permission_offers AS permission_offer ON permission_offer.question_id = q.question_id
    LEFT JOIN run_question_timers AS timer ON timer.question_id = q.question_id
    LEFT JOIN task_contract_proposals AS proposal ON proposal.question_id = q.question_id
    LEFT JOIN space_tasks AS proposal_task ON proposal_task.item_id = proposal.item_id
    -- Each question's latest change: one lookup in idx_journal_question_latest.
    LEFT JOIN ${journalRecordsSql(sql)} AS question_change
      ON question_change.stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
      AND question_change.sequence = (
        SELECT MAX(record.sequence) FROM ${journalRecordsSql(sql)} AS record
        WHERE record.stream_id = ${SESSION_LIFECYCLE_STREAM_ID} AND record.event_type = 'question_changed'
          AND json_extract(record.data_json, '$.question_id') = +q.question_id)
    LEFT JOIN space_tasks AS task ON task.item_id = json_extract(r.metadata_json, '$.run_context.task.item_id')
    LEFT JOIN spaces AS space ON space.space_id = task.space_id`
  // Only an unanswered, unclosed question can be open: this reads the short
  // list in idx_run_questions_unsettled, whose condition it repeats word for word.
  const openSelect = sql`${select} WHERE q.resolution IS NULL AND q.closed_at IS NULL`

  const get = Effect.fn(function* (id: string) {
    const rows = yield* sql<QuestionRow>`${select} WHERE q.question_id = ${id}`.pipe(
      Effect.mapError((cause) => workError("storage", "Could not read Run question", cause))
    )
    if (!rows[0]) return yield* workError("not_found", "Question not found")
    return yield* decode(rows[0])
  })

  const questionFilterClauses = (filter: RunQuestionFilter): ReadonlyArray<Fragment> => {
    switch (filter.kind) {
      case RUN_QUESTION_FILTER.all:
        return []
      case RUN_QUESTION_FILTER.session:
        return [
          sql`(session_id = ${filter.session_id}
      OR json_extract(context, '$.origin.session_id') = ${filter.session_id}
      OR EXISTS (SELECT 1 FROM chat_runs AS destined_run
        WHERE destined_run.run_id = question_scope.run_id
          AND ${runDestinationSessionId(sql, runColumns(sql, "destined_run"))} = ${filter.session_id})
      OR EXISTS (SELECT 1 FROM space_tasks AS asking_task
        WHERE asking_task.item_id = json_extract(question_scope.context, '$.task.item_id')
          AND asking_task.home_session_id = ${filter.session_id}))`
        ]
      case RUN_QUESTION_FILTER.space:
        return [
          sql`EXISTS (
      SELECT 1 FROM chat_runs AS owner_run
      JOIN sessions AS owner_session
        ON owner_session.session_id = ${runDestinationSessionId(sql, runColumns(sql, "owner_run"))}
      JOIN spaces AS owner_space ON owner_space.space_id = owner_session.space_id
      WHERE owner_run.run_id = question_scope.run_id
        AND owner_session.space_id = ${filter.space_id}
        AND owner_session.archived_at IS NULL
        AND owner_space.archived_at IS NULL
    )`
        ]
      case RUN_QUESTION_FILTER.task:
        return [sql`json_extract(context, '$.task.item_id') = ${filter.item_id}`]
    }
  }

  const questions: WorkStore["Service"]["questions"] = Effect.fn(function* (request) {
    const decodedCursor =
      request.page.kind === RUN_PAGE.first
        ? undefined
        : decodeOpaque(CursorSchema, request.page.cursor)
    if (decodedCursor !== undefined && Option.isNone(decodedCursor)) {
      return yield* workError("invalid", "Invalid question cursor")
    }
    const cursor = decodedCursor?.value
    const clauses = [sql`1 = 1`, ...questionFilterClauses(request.filter)]
    if (request.state !== RUN_QUESTION_STATE.all) clauses.push(sql`status = 'open'`)
    if (cursor)
      clauses.push(
        sql`(created_at < ${cursor.at} OR (created_at = ${cursor.at} AND question_id < ${cursor.id}))`
      )
    const rows =
      yield* sql<QuestionRow>`SELECT * FROM (${request.state === RUN_QUESTION_STATE.all ? select : openSelect}) AS question_scope WHERE ${sql.and(clauses)} ORDER BY created_at DESC, question_id DESC LIMIT 101`.pipe(
        Effect.mapError((cause) => workError("storage", "Could not list Run questions", cause))
      )
    const visible = rows.slice(0, 100)
    const last = visible.at(-1)
    return {
      questions: yield* Effect.forEach(visible, decode),
      next:
        rows.length > 100 && last
          ? {
              kind: RUN_PAGE_NEXT.more,
              cursor: encodeOpaque({ at: last.created_at, id: last.question_id })
            }
          : { kind: RUN_PAGE_NEXT.end }
    }
  })
  return { get, questions, select, openSelect, decode }
}
