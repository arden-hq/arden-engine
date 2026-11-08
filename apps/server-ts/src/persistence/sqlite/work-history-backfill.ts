import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill } from "./backfills/backfill.js"

export const taskHistoryBackfill: Backfill = {
  name: "space_task_revisions_baseline",
  chunk: Effect.fn("WorkHistory.taskHistoryBackfill")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* sql<{
      readonly id: string
    }>`SELECT item_id AS id FROM space_tasks WHERE item_id > ${cursor ?? ""} ORDER BY item_id LIMIT ${limit}`
    const inserted = yield* Effect.forEach(
      rows,
      (row) =>
        sql`INSERT INTO space_task_revisions (item_id, version, kind, state_json, recorded_at) SELECT entity.item_id, 1, 'baseline', json_object('space_id', entity.space_id, 'home_session_id', entity.home_session_id, 'stable_key', entity.stable_key, 'text', entity.text, 'body', entity.body, 'status', entity.status, 'owner', entity.owner, 'runs_in', entity.runs_in, 'token_budget', entity.token_budget, 'blocked', entity.blocked, 'waiting_on', entity.waiting_on, 'due_at', entity.due_at, 'next_attempt_at', entity.next_attempt_at, 'completed_at', entity.completed_at, 'created_by', entity.created_by, 'capture', entity.capture, 'continuation_context', entity.continuation_context, 'origin_message_id', entity.origin_message_id, 'original_body', entity.original_body, 'sources', json(COALESCE((SELECT json_group_array(json(source)) FROM (SELECT source FROM space_task_sources WHERE item_id = entity.item_id ORDER BY source_key)), '[]'))), ${now} FROM space_tasks AS entity WHERE entity.item_id = ${row.id} AND NOT EXISTS (SELECT 1 FROM space_task_revisions WHERE item_id = entity.item_id) RETURNING version`
    )
    return {
      converted: inserted.reduce((total, entries) => total + entries.length, 0),
      next: rows.length < limit ? undefined : rows.at(-1)?.id
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly count: number
    }>`SELECT COUNT(*) AS count FROM space_tasks AS entity WHERE NOT EXISTS (SELECT 1 FROM space_task_revisions WHERE item_id = entity.item_id)`
    return row?.count ?? 0
  })
}

export const proposalHistoryBackfill: Backfill = {
  name: "task_proposal_revisions_baseline",
  chunk: Effect.fn("WorkHistory.proposalHistoryBackfill")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* sql<{
      readonly id: string
    }>`SELECT proposal_id AS id FROM task_proposals WHERE proposal_id > ${cursor ?? ""} ORDER BY proposal_id LIMIT ${limit}`
    const inserted = yield* Effect.forEach(
      rows,
      (row) =>
        sql`INSERT INTO task_proposal_revisions (proposal_id, version, kind, state_json, recorded_at) SELECT entity.proposal_id, 1, 'baseline', json_object('place', entity.place, 'space_id', entity.space_id, 'chat_session_id', entity.chat_session_id, 'stable_key', entity.stable_key, 'text', entity.text, 'body', entity.body, 'owner', entity.owner, 'capture_json', entity.capture_json, 'sources_json', entity.sources_json, 'signal_json', entity.signal_json, 'evidence_revision_key', entity.evidence_revision_key, 'candidate_hash', entity.candidate_hash, 'source_run_id', entity.source_run_id, 'source_session_id', entity.source_session_id, 'source_turn_id', entity.source_turn_id, 'source_tool_call_id', entity.source_tool_call_id, 'capture_policy_json', entity.capture_policy_json, 'revision', entity.revision, 'status', entity.status, 'item_id', entity.item_id, 'settlement_client_id', entity.settlement_client_id, 'settlement_decision', entity.settlement_decision, 'settlement_task_json', entity.settlement_task_json, 'settled_at', entity.settled_at, 'retirement_json', entity.retirement_json), ${now} FROM task_proposals AS entity WHERE entity.proposal_id = ${row.id} AND NOT EXISTS (SELECT 1 FROM task_proposal_revisions WHERE proposal_id = entity.proposal_id) RETURNING version`
    )
    return {
      converted: inserted.reduce((total, entries) => total + entries.length, 0),
      next: rows.length < limit ? undefined : rows.at(-1)?.id
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly count: number
    }>`SELECT COUNT(*) AS count FROM task_proposals AS entity WHERE NOT EXISTS (SELECT 1 FROM task_proposal_revisions WHERE proposal_id = entity.proposal_id)`
    return row?.count ?? 0
  })
}
