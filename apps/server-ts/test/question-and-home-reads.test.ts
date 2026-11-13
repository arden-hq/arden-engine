import { journalRecordsSql } from "@arden-hq/journal/effect"
import { HOME_HEADLINES } from "@arden-hq/protocol/effect/runs"
import { Effect, Schema } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SESSION_LIFECYCLE_STREAM_ID } from "../src/persistence/sessions/events.js"
import { makeHomeEvidence } from "../src/persistence/sqlite/home-evidence.js"
import { ruleSavedInSql } from "../src/persistence/sqlite/permissions.js"
import {
  latestSettledQuestionChanges,
  questionVisiblePredicate
} from "../src/persistence/sqlite/question-events.js"
import { runColumns, runDestinationSessionId } from "../src/persistence/sqlite/run-destination.js"
import { quietRunOutcome } from "../src/persistence/sqlite/run-outcomes.js"
import {
  makeRunQuestionReader,
  type QuestionRow
} from "../src/persistence/sqlite/run-question-read.js"
import { terminalRunStatusList } from "../src/persistence/sqlite/status-sets.js"
import { taskHasHold } from "../src/persistence/sqlite/task-hold-state.js"
import { homeOfferJson } from "../src/persistence/sqlite/task-proposal-home.js"
import { taskOpenSql } from "../src/persistence/sqlite/task-status-sql.js"
import { taskRevisionRef } from "../src/persistence/sqlite/work-history.js"
import { decodeOpaque, encodeOpaque } from "../src/lib/opaque-ref.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// The question reads and Home's activity list used to rebuild every question
// and read every row of the window. They now read the unsettled questions,
// each question's latest change by index, and each kind's newest page. These
// tests run the old SQL (kept only here) and the new reads on the same rows,
// including the edge cases, and expect the same answer in the same order.

const HOUR = 3_600_000
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString()

/** The question select before migration 150: a grouped pass over every change. */
const oldQuestionSelect = (sql: SqlClient.SqlClient) => {
  const destinationSessionId = runDestinationSessionId(sql, runColumns(sql, "r"))
  return sql`SELECT q.question_id, q.run_id, json_extract(r.metadata_json, '$.turn_id') AS turn_id, r.session_id, q.content, q.resolution, q.created_at,
    json_extract(r.metadata_json, '$.run_context') AS context,
    CASE WHEN focus_choice.choice_id IS NULL THEN NULL ELSE json_object(
      'space_id', focus_choice.space_id,
      'revision', focus_choice.revision,
      'status', focus_choice.status
    ) END AS focus_choice,
    CASE WHEN permission_offer.question_id IS NULL THEN NULL
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
    COALESCE(NULLIF(trim(asking.name), ''), NULLIF(trim(asking_parent.name), '')) AS source_title,
    CASE WHEN json_extract(question_change.data_json, '$.session_id') IS ${destinationSessionId}
      THEN question_change.sequence ELSE NULL END AS continuity_revision,
    CASE
      WHEN delivery.status = 'pending' THEN json_object('kind', 'queued')
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
    LEFT JOIN automation_deliveries AS delivery ON json_extract(delivery.payload, '$.questionId') = q.question_id
      AND json_extract(delivery.payload, '$.kind') = 'answer'
    LEFT JOIN chat_idempotency_keys AS answer_receipt
      ON answer_receipt.session_id = json_extract(delivery.payload, '$.sessionId')
      AND answer_receipt.client_id = 'arrival:' || delivery.delivery_id
    LEFT JOIN sessions AS asking ON asking.session_id = COALESCE(
      json_extract(r.metadata_json, '$.run_context.origin.session_id'), r.session_id)
    LEFT JOIN sessions AS asking_parent ON asking_parent.session_id = asking.parent_session_id
    LEFT JOIN focus_choices AS focus_choice ON focus_choice.question_id = q.question_id
    LEFT JOIN permission_offers AS permission_offer ON permission_offer.question_id = q.question_id
    LEFT JOIN run_question_timers AS timer ON timer.question_id = q.question_id
    LEFT JOIN task_contract_proposals AS proposal ON proposal.question_id = q.question_id
    LEFT JOIN space_tasks AS proposal_task ON proposal_task.item_id = proposal.item_id
    LEFT JOIN (
      SELECT json_extract(record.data_json, '$.question_id') AS question_id, MAX(record.sequence) AS sequence
      FROM ${journalRecordsSql(sql)} AS record
      WHERE record.stream_id = ${SESSION_LIFECYCLE_STREAM_ID} AND record.event_type = 'question_changed'
      GROUP BY json_extract(record.data_json, '$.question_id')
    ) AS latest_change ON latest_change.question_id = q.question_id
    LEFT JOIN ${journalRecordsSql(sql)} AS question_change
      ON question_change.stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
      AND question_change.sequence = latest_change.sequence
    LEFT JOIN space_tasks AS task ON task.item_id = json_extract(r.metadata_json, '$.run_context.task.item_id')
    LEFT JOIN spaces AS space ON space.space_id = task.space_id`
}

interface ListRequest {
  readonly session_id?: string
  readonly space_id?: string
  readonly item_id?: string
  readonly state?: "actionable" | "all"
  readonly cursor?: { readonly at: string; readonly id: string }
}

/** The question list before migration 150: every question, then the filters. */
const oldQuestionList = (sql: SqlClient.SqlClient, request: ListRequest) => {
  const clauses: Array<Statement.Fragment> = [sql`1 = 1`]
  if (request.session_id)
    clauses.push(sql`(session_id = ${request.session_id}
      OR json_extract(context, '$.origin.session_id') = ${request.session_id}
      OR EXISTS (SELECT 1 FROM chat_runs AS destined_run
        WHERE destined_run.run_id = question_scope.run_id
          AND ${runDestinationSessionId(sql, runColumns(sql, "destined_run"))} = ${request.session_id})
      OR EXISTS (SELECT 1 FROM space_tasks AS asking_task
        WHERE asking_task.item_id = json_extract(question_scope.context, '$.task.item_id')
          AND asking_task.home_session_id = ${request.session_id}))`)
  if (request.space_id)
    clauses.push(sql`EXISTS (
      SELECT 1 FROM chat_runs AS owner_run
      JOIN sessions AS owner_session
        ON owner_session.session_id = ${runDestinationSessionId(sql, runColumns(sql, "owner_run"))}
      JOIN spaces AS owner_space ON owner_space.space_id = owner_session.space_id
      WHERE owner_run.run_id = question_scope.run_id
        AND owner_session.space_id = ${request.space_id}
        AND owner_session.archived_at IS NULL
        AND owner_space.archived_at IS NULL
    )`)
  if (request.item_id)
    clauses.push(sql`json_extract(context, '$.task.item_id') = ${request.item_id}`)
  if (request.state !== "all") clauses.push(sql`status = 'open'`)
  if (request.cursor)
    clauses.push(
      sql`(created_at < ${request.cursor.at} OR (created_at = ${request.cursor.at} AND question_id < ${request.cursor.id}))`
    )
  return sql<QuestionRow>`SELECT * FROM (${oldQuestionSelect(sql)}) AS question_scope WHERE ${sql.and(clauses)} ORDER BY created_at DESC, question_id DESC LIMIT 101`
}

/** Home's activity list before migration 150: every row of the window, then the page. */
const oldHomeEvidence = (sql: SqlClient.SqlClient, since: string, through: string) => sql`
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
  FROM (${oldQuestionSelect(sql)} WHERE q.resolution IS NULL AND q.closed_at IS NULL) WHERE status = 'open'
  UNION ALL
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

const oldHomePage = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  since: string,
  through: string,
  cursor: { readonly at: string; readonly id: string } | undefined
) {
  const evidence = oldHomeEvidence(sql, since, through)
  const rows = yield* sql<{ readonly id: string; readonly at: string; readonly payload: string }>`
    SELECT id, at, payload FROM (${evidence})
    WHERE (${cursor?.at ?? null} IS NULL OR (at, id) < (${cursor?.at ?? null}, ${cursor?.id ?? null}))
    ORDER BY at DESC, id DESC LIMIT 101`
  const action =
    yield* sql`SELECT 1 FROM (${evidence}) WHERE kind IN ('question', 'approval') LIMIT 1`
  return {
    headline: HOME_HEADLINES[action.length === 0 ? 0 : 1],
    entries: rows.slice(0, 100).map((row) => JSON.parse(row.payload) as unknown),
    more: rows.length > 100
  }
})

const run = (
  session: string,
  id: string,
  hoursAgo: number,
  metadata: object,
  status = "completed"
) =>
  `INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, ended_at, metadata_json,
     assistant_message_id, error_message)
   VALUES ('${id}', '${session}', '${status}', '${at(hoursAgo + 1)}', '${at(hoursAgo)}',
     ${status === "running" ? "NULL" : `'${at(hoursAgo)}'`}, '${JSON.stringify({ turn_id: `t-${id}`, ...metadata })}',
     'am-${id}', ${status === "failed" ? "'It broke.'" : "NULL"})`

const chatContext = (session: string, task?: { item_id: string; generation: number }) => ({
  run_context: { origin: { kind: "chat", session_id: session, turn_id: "t" }, task: task ?? null }
})

const question = (
  id: string,
  runId: string,
  createdAt: string,
  settled: "open" | "resolved" | "closed" = "open"
) =>
  `INSERT INTO run_questions (question_id, run_id, tool_call_id, content, created_at, resolution, closed_at)
   VALUES ('${id}', '${runId}', 'call-${id}',
     '{"prompt":"Which one?","detail":null,"choices":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}',
     '${createdAt}',
     ${settled === "resolved" ? `'{"client_id":"c-${id}","answer":{"kind":"text","text":"A"},"resolved_at":"${createdAt}"}'` : "NULL"},
     ${settled === "closed" ? `'${createdAt}'` : "NULL"})`

const change = (sequence: number, questionId: string, session: string) =>
  `INSERT INTO journal_records (stream_id, sequence, event_type, data_json, attributes_json, created_at)
   VALUES ('${SESSION_LIFECYCLE_STREAM_ID}', ${sequence}, 'question_changed',
     '${JSON.stringify({ type: "question_changed", session_id: session, question_id: questionId, run_id: "x", item_id: null })}',
     '{}', '${at(1)}')`

// Chats in a live Space, an archived chat, a chat in an archived Space; Tasks
// open, deferred and at another generation; questions open, answered, closed,
// hidden by each of those, and two with the same creation time.
const seed = (sql: SqlClient.SqlClient) =>
  Effect.forEach(
    [
      `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
         VALUES ('sp-live', 'Live', 'live', '${at(900)}', '${at(900)}')`,
      `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at, archived_at)
         VALUES ('sp-gone', 'Gone', 'gone', '${at(900)}', '${at(900)}', '${at(5)}')`,
      ...(
        [
          ["chat-a", "'sp-live'", "NULL", "'Alpha'"],
          ["chat-b", "NULL", "NULL", "'Beta'"],
          ["chat-c", "NULL", `'${at(3)}'`, "NULL"],
          ["chat-d", "'sp-gone'", "NULL", "'Delta'"]
        ] as const
      ).map(
        ([id, space, archived, name]) =>
          `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, space_id, archived_at, name)
           VALUES ('${id}', 'ref-${id}', '${at(1000)}', '${at(1)}', 'chat', ${space}, ${archived}, ${name})`
      ),
      ...(
        [
          ["task-open", "open", 0, "worker"],
          ["task-later", "open", 1, "worker"],
          ["task-deferred", "deferred", 0, "user"],
          ["task-done", "done", 0, "worker"]
        ] as const
      ).map(
        ([id, status, generation, owner]) =>
          `INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner, created_at, updated_at, generation)
           VALUES ('${id}', 'sp-live', '${id}', 'Task ${id}', '${status}', '${owner}', '${at(1000)}', '${at(2)}', ${generation})`
      ),
      run("chat-a", "r-a", 50, chatContext("chat-a")),
      run("chat-a", "r-a-task", 40, chatContext("chat-a", { item_id: "task-open", generation: 0 })),
      run(
        "chat-a",
        "r-a-old-gen",
        40,
        chatContext("chat-a", { item_id: "task-later", generation: 0 })
      ),
      run("chat-b", "r-b", 30, chatContext("chat-b")),
      run(
        "chat-b",
        "r-b-deferred",
        30,
        chatContext("chat-b", { item_id: "task-deferred", generation: 0 })
      ),
      run("chat-c", "r-c", 20, chatContext("chat-c")),
      run("chat-d", "r-d", 20, chatContext("chat-d")),
      question("q-open-a", "r-a", at(10)),
      question("q-open-b", "r-b", at(10)),
      question("q-answered", "r-a", at(9), "resolved"),
      question("q-closed", "r-b", at(8), "closed"),
      question("q-archived-chat", "r-c", at(7)),
      question("q-archived-space", "r-d", at(7)),
      question("q-old-generation", "r-a-old-gen", at(6)),
      question("q-deferred", "r-b-deferred", at(6)),
      question("q-task", "r-a-task", at(5)),
      question("q-long-ago", "r-b", at(24 * 60)),
      `UPDATE journal_streams SET head_sequence = MAX(head_sequence, 900000)
         WHERE stream_id = '${SESSION_LIFECYCLE_STREAM_ID}'`,
      `INSERT OR IGNORE INTO journal_streams (stream_id, head_sequence) VALUES ('${SESSION_LIFECYCLE_STREAM_ID}', 900000)`,
      change(800001, "q-open-a", "chat-a"),
      change(800002, "q-answered", "chat-a"),
      change(800003, "q-open-a", "chat-b"),
      change(800004, "q-task", "chat-a"),
      change(800005, "q-open-b", "chat-b"),
      change(800006, "q-closed", "chat-b"),
      change(800007, "q-answered", "chat-a"),
      change(800008, "q-closed", "chat-a"),
      // An answer waiting to be delivered, and one delivered into the asking run.
      `INSERT INTO automation_deliveries (delivery_id, subject, body, payload, status, created_at, destinations)
         VALUES (printf('%064x', 1), 'Answer', 'A', '{"kind":"answer","questionId":"q-open-b","sessionId":"chat-b"}',
           'pending', '${at(4)}', '["run:r-b"]')`,
      `INSERT INTO automation_deliveries (delivery_id, subject, body, payload, status, created_at, delivered_at, destinations)
         VALUES (printf('%064x', 2), 'Answer', 'A', '{"kind":"answer","questionId":"q-answered","sessionId":"chat-a"}',
           'delivered', '${at(4)}', '${at(4)}', '["run:r-a"]')`,
      // Home: Task events and worker notes over sixty days, with equal times,
      // a scheduled event and a user's note (both left out), and worker runs.
      `INSERT INTO space_task_events (space_id, item_id, event_type, summary, created_at)
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 239)
         SELECT 'sp-live', CASE i % 3 WHEN 0 THEN 'task-open' WHEN 1 THEN 'task-done' ELSE 'task-deferred' END,
           CASE WHEN i % 11 = 0 THEN 'scheduled' ELSE 'updated' END, 'Step ' || i,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i / 2 * 6) || ' hours')
         FROM n`,
      `INSERT INTO space_task_comments (space_id, item_id, author, body, created_at)
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 59)
         SELECT 'sp-live', 'task-open', CASE WHEN i % 4 = 0 THEN 'user' ELSE 'worker' END, 'Note ' || i,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 20) || ' hours')
         FROM n`,
      `INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, ended_at, metadata_json, assistant_message_id, error_message)
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 149)
         SELECT 'w-' || i, 'chat-b', CASE i % 5 WHEN 0 THEN 'failed' WHEN 1 THEN 'cancelled' ELSE 'completed' END,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 9 + 1) || ' hours'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 9) || ' hours'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 9) || ' hours'),
           json_object('turn_id', 't-w-' || i,
             'run_policy', json_object('execution', json_object('mode', CASE WHEN i % 7 = 0 THEN 'inline' ELSE 'worker' END)),
             'run_context', CASE WHEN i % 3 = 0 THEN json_object('origin', json_object('kind', 'chat', 'session_id', 'chat-b', 'turn_id', 't'),
               'task', json_object('item_id', CASE WHEN i % 2 = 0 THEN 'task-open' ELSE 'task-deferred' END, 'generation', 0))
               ELSE json_object('origin', json_object('kind', 'chat', 'session_id', 'chat-b', 'turn_id', 't'), 'task', NULL) END,
             'terminal_result', json_object('text', 'Result ' || i),
             'late_result_at', CASE WHEN i % 13 = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i * 4) || ' hours') END),
           'am-w-' || i, CASE WHEN i % 5 = 0 THEN 'It broke.' END
         FROM n`
    ],
    (statement) => sql.unsafe(statement),
    { discard: true }
  )

const sorted = <A>(rows: ReadonlyArray<A>) => rows.map((row) => JSON.stringify(row)).toSorted()

it("the question reads return what the old full rebuild returned", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const reader = makeRunQuestionReader(sql)
      const requests: ReadonlyArray<ListRequest> = [
        {},
        { state: "all" },
        { session_id: "chat-a" },
        { session_id: "chat-b", state: "all" },
        { space_id: "sp-live" },
        { item_id: "task-open" },
        { state: "all", cursor: { at: at(7), id: "q-archived-space" } }
      ]
      for (const request of requests) {
        const { cursor, ...rest } = request
        const page = yield* reader.questions({
          ...rest,
          ...(cursor === undefined ? {} : { cursor: encodeOpaque(cursor) })
        })
        const old = yield* oldQuestionList(sql, request)
        const expected = yield* Effect.forEach(old.slice(0, 100), reader.decode)
        expect(page.questions, JSON.stringify(request)).toEqual(expected)
      }
      // The Inbox's open questions, compared as sets: it sorts them itself.
      const inbox = yield* sql`SELECT * FROM (${reader.openSelect}) WHERE status = 'open'`
      const oldInbox = yield* sql`SELECT * FROM (${oldQuestionSelect(sql)}) WHERE status = 'open'`
      expect(inbox.length).toBeGreaterThan(1)
      expect(sorted(inbox)).toEqual(sorted(oldInbox))
      expect(inbox.map((row) => row["question_id"]).toSorted()).toEqual([
        "q-long-ago",
        "q-open-a",
        "q-open-b",
        "q-task"
      ])
      // The settled changes the Space acknowledgement reads, for each range.
      const oldSettled = (after: number, through: number) => sql`
        SELECT * FROM (
          SELECT question.question_id, latest.sequence AS revision,
            CASE WHEN question.resolution IS NOT NULL THEN 'resolved' ELSE 'closed' END AS status,
            destination.space_id AS destination_space_id,
            destination.session_id AS destination_session_id
          FROM run_questions AS question
          JOIN chat_runs AS run ON run.run_id = question.run_id
          JOIN ${journalRecordsSql(sql)} AS latest
            ON latest.stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
            AND latest.event_type = 'question_changed'
            AND latest.sequence = (
              SELECT MAX(record.sequence)
              FROM ${journalRecordsSql(sql)} AS record
              WHERE record.stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
                AND record.event_type = 'question_changed'
                AND json_extract(record.data_json, '$.question_id') = question.question_id
            )
          JOIN sessions AS destination
            ON destination.session_id = ${runDestinationSessionId(sql, runColumns(sql, "run"))}
            AND destination.session_id = json_extract(latest.data_json, '$.session_id')
          WHERE question.resolution IS NOT NULL OR question.closed_at IS NOT NULL)
        WHERE revision > ${after} AND revision <= ${through}`
      let found = 0
      for (const [after, through] of [
        [0, 900000],
        [800002, 800007],
        [800007, 800008],
        [800003, 800006]
      ] as const) {
        const settled =
          yield* sql`SELECT * FROM (${latestSettledQuestionChanges(sql, { after, through })})`
        expect(sorted(settled), `${after}..${through}`).toEqual(
          sorted(yield* oldSettled(after, through))
        )
        found += settled.length
      }
      expect(found).toBeGreaterThan(1)
    })
  )
})

it("Home's activity list pages match the old read of the whole window", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const homeEvidence = makeHomeEvidence({ sql, consistent: (read) => read })
      for (const days of [3, 30, 90]) {
        const since = at(days * 24)
        let cursor: string | undefined
        let pages = 0
        do {
          const page = yield* homeEvidence({ since, ...(cursor === undefined ? {} : { cursor }) })
          const position =
            cursor === undefined
              ? undefined
              : decodeOpaque(Schema.Struct({ at: Schema.String, id: Schema.String }), cursor)
          const old = yield* oldHomePage(
            sql,
            page.window.since,
            page.window.through,
            position?._tag === "Some" ? position.value : undefined
          )
          expect(page.headline, `${days} days, page ${pages}`).toBe(old.headline)
          expect(page.entries, `${days} days, page ${pages}`).toEqual(old.entries)
          expect(page.next_cursor !== null, `${days} days, page ${pages}`).toBe(old.more)
          cursor = page.next_cursor ?? undefined
          pages += 1
        } while (cursor !== undefined)
        // The long windows span more than one page.
        if (days === 90) expect(pages).toBeGreaterThan(2)
      }
    })
  )
})
