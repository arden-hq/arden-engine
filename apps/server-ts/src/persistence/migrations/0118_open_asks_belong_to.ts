import type { Migration } from "./index.js"

export const openAsksBelongTo: Migration = {
  version: 118,
  name: "open_asks_belong_to",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("DROP TRIGGER chat_runs_immutable_context")
    database.exec(`CREATE TRIGGER chat_runs_immutable_context
      BEFORE UPDATE OF metadata_json ON chat_runs
      WHEN (json_extract(OLD.metadata_json, '$.run_context') IS NOT NULL
        AND (json_remove(json_extract(NEW.metadata_json, '$.run_context'), '$.belongs_to')
            IS NOT json_remove(json_extract(OLD.metadata_json, '$.run_context'), '$.belongs_to')
          OR (json_type(OLD.metadata_json, '$.run_context.belongs_to') IS NOT NULL
            AND json_extract(NEW.metadata_json, '$.run_context.belongs_to')
              IS NOT json_extract(OLD.metadata_json, '$.run_context.belongs_to'))))
        OR (json_extract(OLD.metadata_json, '$.run_policy') IS NOT NULL
        AND json_extract(NEW.metadata_json, '$.run_policy') IS NOT json_extract(OLD.metadata_json, '$.run_policy'))
      BEGIN
        SELECT RAISE(ABORT, 'Run origin and Task binding are immutable');
      END`)
    database.exec(`WITH RECURSIVE targets AS (
        SELECT run_id FROM tool_approvals WHERE status = 'pending'
        UNION SELECT run_id FROM deferred_tool_calls WHERE status = 'pending'
        UNION SELECT run_id FROM run_questions WHERE closed_at IS NULL
        UNION SELECT run_id FROM chat_runs
          WHERE status NOT IN ('completed', 'cancelled', 'error', 'interrupted', 'failed')
      ), caused AS (
        SELECT run.run_id,
          CASE WHEN json_extract(run.metadata_json, '$.run_context.origin.turn_id') LIKE 'arrival:%'
            THEN (SELECT json_extract(delivery.payload, '$.runIds[0]')
              FROM automation_deliveries AS delivery
              WHERE delivery.delivery_id =
                substr(json_extract(run.metadata_json, '$.run_context.origin.turn_id'), 9))
            ELSE (SELECT owner.parent_run_id FROM sessions AS owner
              WHERE owner.session_id = run.session_id AND owner.session_type = 'agent')
          END AS cause_run_id
        FROM chat_runs AS run
        JOIN sessions AS chat ON chat.session_id = run.session_id
        WHERE json_extract(run.metadata_json, '$.run_context.origin.kind') = 'chat'
          AND json_type(run.metadata_json, '$.run_context.belongs_to') IS NULL
          AND NOT (chat.session_type = 'chat' AND chat.origin_automation_id IS NULL)
      ), chain(start_id, run_id, depth) AS (
        SELECT caused.run_id, caused.cause_run_id, 1 FROM caused
        JOIN targets ON targets.run_id = caused.run_id
        WHERE caused.cause_run_id IS NOT NULL
        UNION ALL
        SELECT chain.start_id, caused.cause_run_id, chain.depth + 1 FROM chain
        JOIN caused ON caused.run_id = chain.run_id
        WHERE caused.cause_run_id IS NOT NULL AND chain.depth < 16
      ), last AS (
        SELECT chain.start_id, chain.run_id FROM chain
        JOIN chat_runs AS known ON known.run_id = chain.run_id
        WHERE chain.depth = (SELECT MAX(deepest.depth) FROM chain AS deepest
          JOIN chat_runs AS reached ON reached.run_id = deepest.run_id
          WHERE deepest.start_id = chain.start_id)
      ), owners AS (
        SELECT last.start_id AS run_id,
          CASE
            WHEN json_type(cause.metadata_json, '$.run_context.belongs_to') IS NOT NULL
              THEN json_extract(cause.metadata_json, '$.run_context.belongs_to')
            WHEN json_extract(cause.metadata_json, '$.run_context.origin.kind') != 'chat'
              THEN json_extract(cause.metadata_json, '$.run_context.origin')
            WHEN EXISTS (SELECT 1 FROM sessions AS watched
                WHERE watched.session_id =
                  json_extract(cause.metadata_json, '$.run_context.origin.session_id')
                  AND watched.session_type = 'chat' AND watched.origin_automation_id IS NULL)
              THEN json_extract(cause.metadata_json, '$.run_context.origin')
            ELSE (SELECT json_object('kind', 'automation', 'automation_id', automation.task_id,
                  'occurrence_id', 'before-belongs-to')
              FROM sessions AS hidden
              JOIN scheduled_tasks AS automation ON automation.task_id = hidden.origin_automation_id
                AND automation.purpose = 'user_automation'
              WHERE hidden.session_id = cause.session_id)
          END AS owner
        FROM last JOIN chat_runs AS cause ON cause.run_id = last.run_id
      )
      UPDATE chat_runs
      SET metadata_json = json_set(metadata_json, '$.run_context.belongs_to',
        json((SELECT owner FROM owners WHERE owners.run_id = chat_runs.run_id)))
      WHERE run_id IN (SELECT run_id FROM owners WHERE owner IS NOT NULL)`)
  }
}
