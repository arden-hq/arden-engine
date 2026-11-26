import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(
    "CREATE INDEX idx_browser_procedure_invocations_procedure_id_revision ON browser_procedure_invocations(procedure_id, revision)"
  )
  database.exec("CREATE INDEX idx_browser_procedure_jobs_run_id ON browser_procedure_jobs(run_id)")
  database.exec(
    "CREATE INDEX idx_connection_threads_owner_space_id ON connection_threads(owner_space_id)"
  )
  database.exec(
    "CREATE INDEX idx_execution_budgets_task_item_id ON execution_budgets(task_item_id)"
  )
  database.exec(
    "CREATE INDEX idx_focus_choices_result_session_id ON focus_choices(result_session_id)"
  )
  database.exec(
    "CREATE INDEX idx_focus_choices_source_session_id ON focus_choices(source_session_id)"
  )
  database.exec(
    "CREATE INDEX idx_focus_choices_target_session_id ON focus_choices(target_session_id)"
  )
  database.exec(
    "CREATE INDEX idx_journal_retention_held_stream_id ON journal_retention_held(stream_id)"
  )
  database.exec(
    "CREATE INDEX idx_journaled_decision_routes_viewer_session_id ON journaled_decision_routes(viewer_session_id)"
  )
  database.exec("CREATE INDEX idx_permission_rules_from_rule_id ON permission_rules(from_rule_id)")
  database.exec("CREATE INDEX idx_permission_rules_server_name ON permission_rules(server_name)")
  database.exec(
    "CREATE INDEX idx_permission_rules_source_question_id ON permission_rules(source_question_id)"
  )
  database.exec("CREATE INDEX idx_permission_rules_space_id ON permission_rules(space_id)")
  database.exec("CREATE INDEX idx_shown_asks_viewer_session_id ON shown_asks(viewer_session_id)")
  database.exec("CREATE INDEX idx_space_chat_links_session_id ON space_chat_links(session_id)")
  database.exec(
    "CREATE INDEX idx_space_review_checkpoints_run_id ON space_review_checkpoints(run_id)"
  )
  database.exec(
    "CREATE INDEX idx_space_task_attachments_space_id ON space_task_attachments(space_id)"
  )
  database.exec("CREATE INDEX idx_space_task_comments_item_id ON space_task_comments(item_id)")
  database.exec("CREATE INDEX idx_space_task_events_item_id ON space_task_events(item_id)")
  database.exec("CREATE INDEX idx_space_task_holds_question_id ON space_task_holds(question_id)")
  database.exec("CREATE INDEX idx_space_tasks_home_session_id ON space_tasks(home_session_id)")
  database.exec("CREATE INDEX idx_task_contract_lines_item_id ON task_contract_lines(item_id)")
  database.exec(
    "CREATE INDEX idx_task_contract_proposals_item_id ON task_contract_proposals(item_id)"
  )
  database.exec("CREATE INDEX idx_task_proposals_item_id ON task_proposals(item_id)")
  database.exec(
    "CREATE INDEX idx_task_proposals_source_session_id ON task_proposals(source_session_id)"
  )
  database.exec("CREATE INDEX idx_run_sidecars_session ON run_sidecars(session_id)")
  database.exec(
    "CREATE INDEX idx_sessions_origin_automation ON sessions(origin_automation_id) WHERE origin_automation_id IS NOT NULL"
  )
  database.exec(
    "CREATE INDEX idx_sessions_parent_run ON sessions(parent_run_id) WHERE parent_run_id IS NOT NULL"
  )
  database.exec(
    "CREATE INDEX idx_automation_runs_task_ended ON automation_runs(task_id, ended_at DESC) WHERE ended_at IS NOT NULL"
  )
  database.exec(
    "CREATE INDEX idx_chat_runs_origin ON chat_runs(json_extract(metadata_json, '$.run_context.origin'))"
  )
  database.exec(
    "CREATE INDEX idx_automation_deliveries_session ON automation_deliveries(json_extract(payload, '$.sessionId')) WHERE json_extract(payload, '$.sessionId') IS NOT NULL"
  )
  database.exec(
    `CREATE INDEX idx_tool_calls_browser ON tool_calls(run_id) WHERE tool_name IN ('browser_open', 'browser_snapshot', 'browser_act')`
  )
  database.exec(`CREATE TABLE automation_delivery_runs (
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      delivery_id TEXT NOT NULL REFERENCES automation_deliveries(delivery_id) ON DELETE CASCADE,
      PRIMARY KEY (run_id, delivery_id)
    ) WITHOUT ROWID`)
  database.exec(
    `CREATE INDEX idx_chat_runs_automation ON chat_runs(COALESCE(json_extract(metadata_json, '$.run_policy.automation_id'), json_extract(metadata_json, '$.automation.task_id')))`
  )
  database.exec(
    `CREATE INDEX idx_automation_deliveries_paused ON automation_deliveries(task_id) WHERE json_extract(payload, '$.kind') = 'automation_paused'`
  )
  database.exec(
    `CREATE INDEX idx_automation_deliveries_space_paused ON automation_deliveries(task_id) WHERE json_extract(payload, '$.kind') = 'automation_space_paused'`
  )
  database.exec(
    `CREATE INDEX idx_run_endings_failed ON run_endings(run_id) WHERE status = 'failed' AND decided = 1`
  )
  database.exec(
    `CREATE INDEX idx_automation_delivery_runs_delivery ON automation_delivery_runs(delivery_id)`
  )
  database.exec(`INSERT OR IGNORE INTO automation_delivery_runs(run_id, delivery_id)
      SELECT member.value, delivery.delivery_id
      FROM automation_deliveries AS delivery, json_each(delivery.payload, '$.runIds') AS member
      WHERE member.type = 'text' AND length(member.value) > 0`)
  database.exec(`CREATE TRIGGER automation_delivery_runs_ai
      AFTER INSERT ON automation_deliveries
      WHEN json_type(new.payload, '$.runIds') = 'array' BEGIN
        INSERT OR IGNORE INTO automation_delivery_runs(run_id, delivery_id)
          SELECT member.value, new.delivery_id FROM json_each(new.payload, '$.runIds') AS member
          WHERE member.type = 'text' AND length(member.value) > 0;
      END`)
  database.exec(`CREATE TRIGGER automation_delivery_runs_au
      AFTER UPDATE OF payload ON automation_deliveries BEGIN
        DELETE FROM automation_delivery_runs WHERE delivery_id = new.delivery_id;
        INSERT OR IGNORE INTO automation_delivery_runs(run_id, delivery_id)
          SELECT member.value, new.delivery_id FROM json_each(new.payload, '$.runIds') AS member
          WHERE member.type = 'text' AND length(member.value) > 0;
      END`)
}

export const lookupIndexes: Migration = {
  version: 144,
  name: "lookup_indexes",
  foreignKeys: { kind: "enforced" },
  up
}
