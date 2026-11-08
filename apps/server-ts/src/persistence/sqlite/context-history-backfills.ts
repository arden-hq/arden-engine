import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill } from "./backfills/backfill.js"
import { userAutomationSql } from "./authority-sql.js"

export const spaceHistoryBackfill: Backfill = {
  name: "space_revisions_baseline_v2",
  chunk: Effect.fn("ContextHistory.spaceBaseline")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* sql<{
      readonly id: string
    }>`SELECT space_id AS id FROM spaces AS entity WHERE space_id > ${cursor ?? ""} AND 1 ORDER BY space_id LIMIT ${limit}`
    const inserted = yield* Effect.forEach(
      rows,
      (row) => sql`INSERT INTO space_revisions (space_id, version, kind, state_json, recorded_at)
      SELECT entity.space_id, 1, 'baseline', json_object('name', entity.name, 'instructions', entity.instructions, 'instructions_source', entity.instructions_source, 'page_path', entity.page_path, 'page_id', entity.page_id, 'inference_policy', entity.inference_policy, 'archived_at', entity.archived_at), ${now} FROM spaces AS entity
      WHERE entity.space_id = ${row.id} AND NOT EXISTS (SELECT 1 FROM space_revisions WHERE space_id = entity.space_id) RETURNING version`
    )
    return {
      converted: inserted.reduce((total, rows) => total + rows.length, 0),
      next: rows.length < limit ? undefined : rows.at(-1)?.id
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly count: number
    }>`SELECT COUNT(*) AS count FROM spaces AS entity WHERE 1 AND NOT EXISTS (SELECT 1 FROM space_revisions WHERE space_id = entity.space_id)`
    return row?.count ?? 0
  })
}

export const sessionHistoryBackfill: Backfill = {
  name: "session_revisions_baseline_v2",
  chunk: Effect.fn("ContextHistory.sessionBaseline")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* sql<{
      readonly id: string
    }>`SELECT session_id AS id FROM sessions AS entity WHERE session_id > ${cursor ?? ""} AND 1 ORDER BY session_id LIMIT ${limit}`
    const inserted = yield* Effect.forEach(
      rows,
      (
        row
      ) => sql`INSERT INTO session_revisions (session_id, version, kind, state_json, recorded_at)
      SELECT entity.session_id, 1, 'baseline', json_object('name', entity.name, 'archived_at', entity.archived_at, 'session_type', entity.session_type, 'origin_automation_id', entity.origin_automation_id, 'parent_session_id', entity.parent_session_id, 'parent_run_id', entity.parent_run_id, 'parent_tool_call_id', entity.parent_tool_call_id, 'parent_message_id', entity.parent_message_id, 'space_id', entity.space_id, 'chat_model', entity.chat_model, 'approval_mode', json_extract(CASE WHEN json_valid(entity.metadata) THEN entity.metadata ELSE '{}' END, '$.approval_mode'), 'metadata_valid', (entity.metadata IS NULL OR json_valid(entity.metadata))), ${now} FROM sessions AS entity
      WHERE entity.session_id = ${row.id} AND NOT EXISTS (SELECT 1 FROM session_revisions WHERE session_id = entity.session_id) RETURNING version`
    )
    return {
      converted: inserted.reduce((total, rows) => total + rows.length, 0),
      next: rows.length < limit ? undefined : rows.at(-1)?.id
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly count: number
    }>`SELECT COUNT(*) AS count FROM sessions AS entity WHERE 1 AND NOT EXISTS (SELECT 1 FROM session_revisions WHERE session_id = entity.session_id)`
    return row?.count ?? 0
  })
}

export const automationHistoryBackfill: Backfill = {
  name: "automation_configuration_revisions_baseline",
  chunk: Effect.fn("ContextHistory.automationBaseline")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* sql<{
      readonly id: string
    }>`SELECT task_id AS id FROM scheduled_tasks AS entity WHERE task_id > ${cursor ?? ""} AND ${userAutomationSql("entity")} AND entity.builtin = 0 ORDER BY task_id LIMIT ${limit}`
    const inserted = yield* Effect.forEach(
      rows,
      (
        row
      ) => sql`INSERT INTO automation_configuration_revisions (task_id, version, kind, state_json, recorded_at)
      SELECT entity.task_id, 1, 'baseline', json_object('name', entity.name, 'description', entity.description, 'description_source', entity.description_source, 'enabled', entity.enabled, 'auto_approve', entity.auto_approve, 'tool_scope', entity.tool_scope, 'purpose', entity.purpose, 'owner_space_id', entity.owner_space_id, 'owner_task_id', entity.owner_task_id, 'instruction_revision_id', entity.instruction_revision_id), ${now} FROM scheduled_tasks AS entity
      WHERE entity.task_id = ${row.id} AND NOT EXISTS (SELECT 1 FROM automation_configuration_revisions WHERE task_id = entity.task_id) RETURNING version`
    )
    return {
      converted: inserted.reduce((total, rows) => total + rows.length, 0),
      next: rows.length < limit ? undefined : rows.at(-1)?.id
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly count: number
    }>`SELECT COUNT(*) AS count FROM scheduled_tasks AS entity WHERE ${userAutomationSql("entity")} AND entity.builtin = 0 AND NOT EXISTS (SELECT 1 FROM automation_configuration_revisions WHERE task_id = entity.task_id)`
    return row?.count ?? 0
  })
}
