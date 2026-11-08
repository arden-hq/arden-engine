import { DateTime, Effect, Option, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import {
  HOME_HEADLINES,
  HomeEvidencePageSchema,
  HomeEvidenceQuerySchema
} from "@arden-hq/protocol/effect/runs"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import type { HomeStore } from "../home/store.js"
import { WorkStoreError } from "../work/store.js"
import { makeRunQuestionReader } from "./run-question-read.js"
import { quietRunOutcome } from "./run-outcomes.js"
import { decodeJson } from "./json.js"
import { workError } from "./work-records.js"
import { taskHasHold } from "./task-hold-state.js"
import { terminalRunStatusList } from "./status-sets.js"
import { homeOfferJson } from "./task-proposal-home.js"
import { taskRevisionRef } from "./work-history.js"
import { taskOpenSql } from "./task-status-sql.js"
import { decodeOpaque, encodeOpaque } from "../../lib/opaque-ref.js"

const CursorSchema = Schema.Struct({
  since: IsoDateTimeStringSchema,
  through: IsoDateTimeStringSchema,
  at: IsoDateTimeStringSchema,
  id: Schema.NonEmptyString
})

export const makeHomeEvidence = ({
  sql,
  consistent
}: {
  readonly sql: SqlClient.SqlClient
  readonly consistent: <A, E>(read: Effect.Effect<A, E>) => Effect.Effect<A, E | SqlError.SqlError>
}): HomeStore["Service"]["homeEvidence"] => {
  const questions = makeRunQuestionReader(sql)
  return Effect.fn("HomeStore.homeEvidence")(function* (options) {
    const query = yield* Schema.decodeUnknownEffect(HomeEvidenceQuerySchema)(options).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid Home evidence window", cause))
    )
    const since = new Date(query.since).toISOString()
    const now = DateTime.formatIso(yield* DateTime.now)
    const encodedCursor = query.cursor
    const decodedCursor =
      encodedCursor === undefined ? undefined : decodeOpaque(CursorSchema, encodedCursor)
    if (decodedCursor !== undefined && Option.isNone(decodedCursor)) {
      return yield* workError("invalid", "Invalid Home evidence cursor")
    }
    const cursor = decodedCursor?.value
    const through = cursor?.through ?? now
    if (since > through || through > now || (cursor && cursor.since !== since)) {
      return yield* workError("invalid", "Home evidence cursor belongs to another window")
    }
    return yield* consistent(
      Effect.gen(function* () {
        const evidence = sql`
        SELECT 'task:' || event.event_id AS id, event.created_at AS at, 'task' AS kind,
          json_object('id', 'task:' || event.event_id, 'at', event.created_at, 'kind', 'task',
            'event_id', event.event_id, 'item_id', task.item_id, 'title', task.text,
            'history_revision', ${taskRevisionRef(sql, sql`event.item_id`, sql`event.state_version`)},
            'event_type', event.event_type, 'summary', COALESCE(event.result_summary, event.summary), 'run_ref', event.run_ref,
            'status', task.status, 'source_refs', json(event.source_refs)) AS payload
        FROM space_task_events AS event JOIN space_tasks AS task ON task.item_id = event.item_id
          LEFT JOIN spaces AS space ON space.space_id = task.space_id
          LEFT JOIN chat_runs AS source_run ON source_run.run_id = event.run_ref
        WHERE (task.space_id IS NULL OR space.archived_at IS NULL)
          AND task.status <> 'deferred'
          AND (NOT ${taskHasHold(sql, sql`task`)} OR event.event_type = 'on_hold')
          AND event.event_type <> 'scheduled'
          AND event.created_at > ${since} AND event.created_at <= ${through}
          AND NOT EXISTS (SELECT 1 FROM scheduled_tasks AS system_job WHERE system_job.builtin = 1
            AND system_job.task_id = json_extract(source_run.metadata_json, '$.run_context.origin.automation_id'))
        UNION ALL
        -- A worker's note on a Task is news about that Task; the user's own notes are not.
        SELECT 'task:comment:' || comment.comment_id, comment.created_at, 'task',
          json_object('id', 'task:comment:' || comment.comment_id, 'at', comment.created_at, 'kind', 'task',
            'event_id', NULL, 'item_id', task.item_id, 'title', task.text, 'history_revision', NULL,
            'event_type', 'comment', 'summary', comment.body, 'run_ref', NULL,
            'status', task.status, 'source_refs', json_array()) AS payload
        FROM space_task_comments AS comment JOIN space_tasks AS task ON task.item_id = comment.item_id
          LEFT JOIN spaces AS space ON space.space_id = task.space_id
        WHERE comment.author <> 'user'
          AND (task.space_id IS NULL OR space.archived_at IS NULL)
          AND task.status <> 'deferred' AND NOT ${taskHasHold(sql, sql`task`)}
          AND comment.created_at > ${since} AND comment.created_at <= ${through}
        UNION ALL
        SELECT 'run:' || run.run_id, COALESCE(json_extract(run.metadata_json, '$.late_result_at'), run.ended_at), 'run',
          json_object('id', 'run:' || run.run_id, 'at', COALESCE(json_extract(run.metadata_json, '$.late_result_at'), run.ended_at),
            'kind', 'run', 'run_id', run.run_id, 'session_id', run.session_id,
            'context', json_extract(run.metadata_json, '$.run_context'), 'status', run.status,
            'text', COALESCE(json_extract(run.metadata_json, '$.terminal_result.text'), attempt.result, ''),
            'error', COALESCE(run.error_message, attempt.error))
        FROM chat_runs AS run
          LEFT JOIN automation_runs AS attempt ON attempt.chat_run_id = run.run_id
          LEFT JOIN space_tasks AS task ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
          LEFT JOIN spaces AS space ON space.space_id = task.space_id
        WHERE run.status IN ${terminalRunStatusList}
          AND json_extract(run.metadata_json, '$.run_policy.execution.mode') = 'worker'
          AND COALESCE(json_extract(run.metadata_json, '$.late_result_at'), run.ended_at) > ${since}
          AND COALESCE(json_extract(run.metadata_json, '$.late_result_at'), run.ended_at) <= ${through}
          AND (json_extract(run.metadata_json, '$.run_context.task') IS NULL
            OR (task.item_id IS NOT NULL AND task.status <> 'deferred'
              AND NOT ${taskHasHold(sql, sql`task`)} AND space.archived_at IS NULL))
          AND NOT (run.status = 'completed' AND ${quietRunOutcome(sql, "run")})
          AND NOT EXISTS (SELECT 1 FROM scheduled_tasks AS system_job WHERE system_job.builtin = 1
            AND system_job.task_id = json_extract(run.metadata_json, '$.run_context.origin.automation_id'))
        UNION ALL
        SELECT 'question:' || question_id, created_at, 'question',
          json_object('id', 'question:' || question_id, 'at', created_at, 'kind', 'question',
            'question', json_object('question_id', question_id, 'run_id', run_id, 'turn_id', turn_id, 'session_id', session_id,
              'destination_session_id', destination_session_id, 'content', json(content), 'context', json(context), 'resolution', NULL, 'continuation', NULL,
              'focus_choice', json(focus_choice),
              'permission_offer', json(permission_offer),
              'continuity_revision', continuity_revision,
              'created_at', created_at, 'status', status))
        FROM (${questions.select} WHERE q.resolution IS NULL AND q.closed_at IS NULL) WHERE status = 'open'
        UNION ALL
        -- An open Home offer, of any age, like an open question (I-23, D22).
        SELECT 'offer:' || offer.proposal_id, offer.created_at, 'offer',
          json_object('id', 'offer:' || offer.proposal_id, 'at', offer.created_at, 'kind', 'offer',
            'offer', ${homeOfferJson(sql)})
        FROM task_proposals AS offer WHERE offer.place = 'home' AND offer.status = 'offered'
        UNION ALL
        SELECT 'approval:' || json_array(approval.run_id, approval.tool_call_id), approval.requested_at, 'approval',
          json_object('id', 'approval:' || json_array(approval.run_id, approval.tool_call_id), 'at', approval.requested_at,
            'kind', 'approval', 'run_id', approval.run_id, 'session_id', approval.session_id,
            'tool_call_id', approval.tool_call_id, 'tool_name', approval.tool_name, 'preview', approval.preview,
            'context', json_extract(run.metadata_json, '$.run_context'))
        FROM tool_approvals AS approval JOIN chat_runs AS run ON run.run_id = approval.run_id
          LEFT JOIN space_tasks AS task ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
          LEFT JOIN spaces AS space ON space.space_id = task.space_id
        WHERE approval.status = 'pending' AND (json_extract(run.metadata_json, '$.run_context.task') IS NULL
          OR (task.item_id IS NOT NULL AND ${taskOpenSql("task")}
            AND task.generation = json_extract(run.metadata_json, '$.run_context.task.generation') AND space.archived_at IS NULL))`
        const rows = yield* sql<{
          readonly id: string
          readonly at: string
          readonly payload: string
        }>`
        SELECT id, at, payload FROM (${evidence})
        WHERE (${cursor?.at ?? null} IS NULL OR (at, id) < (${cursor?.at ?? null}, ${cursor?.id ?? null}))
        ORDER BY at DESC, id DESC LIMIT 101`
        const action =
          yield* sql`SELECT 1 FROM (${evidence}) WHERE kind IN ('question', 'approval') LIMIT 1`
        const visible = rows.slice(0, 100)
        const last = visible.at(-1)
        return yield* Schema.decodeUnknownEffect(HomeEvidencePageSchema)({
          window: { since, through },
          headline: HOME_HEADLINES[action.length === 0 ? 0 : 1],
          entries: yield* Effect.forEach(visible, (row) => decodeJson(Schema.Json, row.payload)),
          next_cursor:
            rows.length > 100 && last
              ? encodeOpaque({ since, through, at: last.at, id: last.id })
              : null
        })
      })
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkStoreError
          ? cause
          : workError("storage", "Could not read Home evidence", cause)
      )
    )
  })
}
