import type { OperationalSchemaSection } from "../section.js"
import { decisionVisibilityStatements } from "../decision-visibility.js"

export const contextExecutionSchemaSection = {
  name: "context.execution",
  storageDomain: "execution",
  tables: [
    "chat_runs",
    "run_model_usage",
    "execution_budgets",
    "chat_idempotency_keys",
    "session_queued_messages",
    "tool_calls",
    "tool_call_targets",
    "tool_approvals",
    "deferred_tool_calls",
    "pending_decision_visibility",
    "pending_decision_visibility_unresolved",
    "shown_asks",
    "journaled_decision_routes",
    "approval_reviews",
    "session_todos"
  ],
  indexes: [
    "idx_chat_runs_session_status",
    "idx_chat_runs_session_latest",
    "idx_chat_runs_session_origin",
    "idx_chat_runs_active",
    "idx_chat_runs_budget",
    "idx_chat_runs_task_item",
    "idx_execution_budgets_task",
    "idx_chat_idempotency_run",
    "idx_chat_idempotency_expires",
    "idx_session_queued_messages_session",
    "idx_tool_calls_session_started",
    "idx_tool_calls_session_unresolved",
    "idx_tool_call_targets_object",
    "idx_tool_approvals_run",
    "idx_tool_approvals_session_status",
    "idx_tool_approvals_pending_backfill",
    "idx_deferred_tool_calls_status",
    "idx_deferred_tool_calls_pending_backfill",
    "idx_pending_decision_visibility_source",
    "idx_pending_decision_visibility_run_fk",
    "idx_pending_decision_visibility_deferred_fk",
    "idx_pending_decision_visibility_source_session",
    "idx_pending_decision_visibility_unresolved_run_fk",
    "idx_pending_decision_visibility_unresolved_deferred_fk"
  ],
  triggers: [
    "chat_runs_delete_budget",
    "chat_runs_immutable_authority",
    "pending_decision_visibility_run_insert",
    "pending_decision_visibility_run_update",
    "pending_decision_visibility_run_immutable_identity",
    "pending_decision_visibility_deferred_insert",
    "pending_decision_visibility_deferred_update",
    "pending_decision_visibility_deferred_immutable_identity",
    "pending_decision_visibility_immutable_agent_edge"
  ],
  statements: [
    `CREATE TABLE chat_runs (
      run_id TEXT PRIMARY KEY CHECK(length(run_id) > 0),
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'backgrounded', 'interrupted', 'error', 'failed', 'cancelled', 'completed')),
      stop_reason TEXT CHECK(stop_reason IS NULL OR length(stop_reason) > 0),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      last_seq INTEGER CHECK(last_seq IS NULL OR last_seq >= 0),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT CHECK(error_code IS NULL OR length(error_code) > 0),
      error_message TEXT,
      client_id TEXT CHECK(client_id IS NULL OR length(client_id) > 0),
      assistant_message_id TEXT NOT NULL CHECK(length(assistant_message_id) > 0),
      model_id TEXT CHECK(model_id IS NULL OR length(model_id) > 0),
      reasoning_effort TEXT CHECK(reasoning_effort IS NULL OR length(reasoning_effort) > 0),
      CHECK(updated_at >= started_at),
      CHECK(ended_at IS NULL OR (ended_at >= started_at AND ended_at <= updated_at)),
      CHECK(status NOT IN ('pending', 'running', 'backgrounded') OR (ended_at IS NULL AND stop_reason IS NULL AND error_code IS NULL AND error_message IS NULL)),
      CHECK(status IN ('pending', 'running', 'backgrounded') OR ended_at IS NOT NULL),
      CHECK(status <> 'interrupted' OR stop_reason IS NOT NULL),
      CHECK(status <> 'completed' OR (error_code IS NULL AND error_message IS NULL))
    )`,
    "CREATE INDEX idx_chat_runs_session_status ON chat_runs(session_id, status)",
    "CREATE INDEX idx_chat_runs_session_latest ON chat_runs(session_id, updated_at DESC, started_at DESC, run_id DESC)",
    "CREATE INDEX idx_chat_runs_session_origin ON chat_runs(session_id, json_extract(metadata_json, '$.run_context.origin'), started_at DESC, run_id DESC)",
    `CREATE INDEX idx_chat_runs_active
      ON chat_runs(status)
      WHERE status IN ('pending', 'running')`,
    `CREATE TABLE chat_idempotency_keys (
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      client_id TEXT NOT NULL CHECK(length(client_id) > 0),
      request_hash TEXT NOT NULL CHECK(length(request_hash) > 0),
      run_id TEXT CHECK(run_id IS NULL OR length(run_id) > 0),
      message_id TEXT CHECK(message_id IS NULL OR length(message_id) > 0),
      message_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('accepted', 'queued', 'running', 'ingested', 'completed', 'cancelled', 'error', 'failed', 'interrupted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      PRIMARY KEY (session_id, client_id),
      CHECK(status IN ('accepted', 'cancelled') OR run_id IS NOT NULL),
      CHECK(updated_at >= created_at),
      CHECK(expires_at IS NULL OR expires_at >= updated_at)
    )`,
    "CREATE INDEX idx_chat_idempotency_run ON chat_idempotency_keys(run_id)",
    "CREATE INDEX idx_chat_idempotency_expires ON chat_idempotency_keys(expires_at)",
    `CREATE TABLE session_queued_messages (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE CHECK(length(session_id) > 0),
      client_id TEXT NOT NULL CHECK(length(client_id) > 0),
      message TEXT NOT NULL,
      images_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(images_json) AND json_type(images_json) = 'array'),
      enqueued_at TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
      PRIMARY KEY (session_id, client_id),
      CHECK(length(message) > 0 OR json_array_length(images_json) > 0)
    )`,
    "CREATE INDEX idx_session_queued_messages_session ON session_queued_messages(session_id, enqueued_at, client_id)",
    "ALTER TABLE session_queued_messages ADD COLUMN sent_from TEXT CHECK(sent_from IS NULL OR sent_from IN ('answer', 'visualization'))",
    "ALTER TABLE session_queued_messages ADD COLUMN failed_reason TEXT CHECK(failed_reason IS NULL OR length(failed_reason) > 0)",
    "ALTER TABLE session_queued_messages ADD COLUMN failed_at TEXT",
    `CREATE TABLE tool_calls (
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE CHECK(length(run_id) > 0),
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE CHECK(length(session_id) > 0),
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      tool_name TEXT NOT NULL CHECK(length(tool_name) > 0),
      arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
      changes_state INTEGER NOT NULL CHECK(changes_state IN (0, 1)),
      status TEXT NOT NULL CHECK(status IN ('running', 'ready', 'completed', 'paused', 'uncertain')),
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (run_id, tool_call_id),
      UNIQUE (run_id, session_id, tool_call_id),
      CHECK(
        (status IN ('running', 'ready') AND result_json IS NULL AND ended_at IS NULL) OR
        (status = 'paused' AND result_json IS NULL AND ended_at IS NOT NULL) OR
        (status IN ('completed', 'uncertain') AND result_json IS NOT NULL AND ended_at IS NOT NULL)
      ),
      CHECK(ended_at IS NULL OR ended_at >= started_at)
    )`,
    "CREATE INDEX idx_tool_calls_session_started ON tool_calls(session_id, started_at)",
    // Reads for a Session's unsettled calls repeat this WHERE
    // (`unresolvedToolStatusList`) so SQLite can use the partial index.
    `CREATE INDEX idx_tool_calls_session_unresolved
      ON tool_calls(session_id, status)
      WHERE status IN ('running', 'ready', 'paused', 'uncertain')`,
    "ALTER TABLE tool_calls ADD COLUMN effect TEXT CHECK(effect IS NULL OR effect IN ('none', 'run_record', 'arden_db', 'local_files', 'external'))",
    `CREATE TABLE tool_call_targets (
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK(length(source) > 0),
      object_id TEXT NOT NULL CHECK(length(object_id) > 0),
      at TEXT NOT NULL,
      title TEXT,
      href TEXT,
      origin TEXT NOT NULL DEFAULT 'named' CHECK(origin IN ('named', 'created')), place TEXT,
      PRIMARY KEY (run_id, tool_call_id, source, object_id),
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
    "CREATE INDEX idx_tool_call_targets_object ON tool_call_targets(source, object_id, at)",
    "ALTER TABLE chat_runs ADD COLUMN authority_json TEXT CHECK(authority_json IS NULL OR (json_valid(authority_json) AND json_type(authority_json) = 'object'))",
    "ALTER TABLE chat_runs ADD COLUMN completion_message_id TEXT",
    `CREATE TRIGGER chat_runs_immutable_authority
      BEFORE UPDATE OF authority_json ON chat_runs
      WHEN OLD.authority_json IS NOT NULL AND NEW.authority_json IS NOT OLD.authority_json
      BEGIN
        SELECT RAISE(ABORT, 'Run authority is immutable');
      END`,
    `CREATE TABLE tool_approvals (
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      tool_name TEXT NOT NULL CHECK(length(tool_name) > 0),
      action TEXT NOT NULL CHECK(length(action) > 0),
      scope TEXT NOT NULL CHECK(length(scope) > 0),
      preview TEXT,
      diff TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      expires_at TEXT,
      result_feedback TEXT,
      kind TEXT NOT NULL DEFAULT 'tool_approval' CHECK(kind IN ('tool_approval', 'tool_outcome')),
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
      resolution_json TEXT CHECK(resolution_json IS NULL OR (json_valid(resolution_json) AND json_type(resolution_json) = 'object')),
      PRIMARY KEY (run_id, tool_call_id),
      FOREIGN KEY (run_id, session_id, tool_call_id)
        REFERENCES tool_calls(run_id, session_id, tool_call_id) ON DELETE CASCADE,
      CHECK(expires_at IS NULL OR expires_at >= requested_at),
      CHECK(
        (status = 'pending' AND resolved_at IS NULL AND resolution_json IS NULL) OR
        (status IN ('approved', 'rejected') AND resolved_at IS NOT NULL AND resolution_json IS NOT NULL)
      )
    )`,
    "CREATE INDEX idx_tool_approvals_run ON tool_approvals(run_id)",
    "CREATE INDEX idx_tool_approvals_session_status ON tool_approvals(session_id, status)",
    `CREATE TABLE deferred_tool_calls (
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      tool_name TEXT NOT NULL CHECK(length(tool_name) > 0),
      action TEXT NOT NULL CHECK(length(action) > 0),
      scope TEXT NOT NULL CHECK(length(scope) > 0),
      preview TEXT,
      diff TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
      arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
      changes_state INTEGER NOT NULL CHECK(changes_state IN (0, 1)),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'ran')),
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
      PRIMARY KEY (run_id, tool_call_id),
      FOREIGN KEY (run_id, session_id, tool_call_id)
        REFERENCES tool_calls(run_id, session_id, tool_call_id) ON DELETE CASCADE,
      CHECK((status = 'pending') = (resolved_at IS NULL)),
      CHECK((status = 'ran') = (result_json IS NOT NULL))
    )`,
    "CREATE INDEX idx_deferred_tool_calls_status ON deferred_tool_calls(status, session_id)",
    ...decisionVisibilityStatements,
    `CREATE TABLE shown_asks (
      ask_kind TEXT NOT NULL CHECK(ask_kind IN ('question', 'card')),
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      ask_id TEXT NOT NULL CHECK(length(ask_id) > 0),
      viewer_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      route_basis TEXT,
      PRIMARY KEY (ask_kind, run_id, ask_id, viewer_session_id)
    ) WITHOUT ROWID`,
    `CREATE TABLE journaled_decision_routes (
      source_kind TEXT NOT NULL CHECK(source_kind IN ('run', 'deferred')),
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      viewer_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      source_session_id TEXT NOT NULL CHECK(length(source_session_id) > 0),
      route_basis TEXT NOT NULL CHECK(length(route_basis) > 0),
      PRIMARY KEY (source_kind, run_id, tool_call_id, viewer_session_id)
    ) WITHOUT ROWID`,
    `CREATE TABLE approval_reviews (
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE CHECK(length(run_id) > 0),
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      tool_name TEXT NOT NULL CHECK(length(tool_name) > 0),
      reviewed_at TEXT NOT NULL,
      rung TEXT NOT NULL CHECK(rung IN ('always_ask', 'standing', 'boundary', 'override', 'requirement', 'default')),
      model_id TEXT,
      decision TEXT NOT NULL CHECK(decision IN ('allow', 'ask')),
      decided_by TEXT NOT NULL CHECK(decided_by IN ('outcome', 'policy', 'timed_out', 'failed', 'stopped')),
      verdict TEXT CHECK(verdict IS NULL OR verdict IN ('allow', 'ask')),
      risk TEXT CHECK(risk IS NULL OR risk IN ('low', 'medium', 'high', 'critical')),
      user_authorization TEXT CHECK(user_authorization IS NULL OR user_authorization IN ('high', 'medium', 'low', 'unknown')),
      authorization_source TEXT CHECK(authorization_source IS NULL OR authorization_source IN ('owner', 'brief')),
      policy_category TEXT CHECK(policy_category IS NULL OR policy_category IN ('none', 'external_send', 'delete_data', 'spend')),
      narrowly_scoped INTEGER CHECK(narrowly_scoped IS NULL OR narrowly_scoped IN (0, 1)),
      malicious_prompt_injection INTEGER CHECK(malicious_prompt_injection IS NULL OR malicious_prompt_injection IN (0, 1)),
      abbreviated INTEGER CHECK(abbreviated IS NULL OR abbreviated IN (0, 1)),
      rationale TEXT,
      PRIMARY KEY (run_id, tool_call_id),
      CHECK((verdict IS NULL) = (decided_by IN ('timed_out', 'failed', 'stopped'))),
      CHECK((verdict IS NULL) = (risk IS NULL) AND (verdict IS NULL) = (user_authorization IS NULL)
        AND (verdict IS NULL) = (authorization_source IS NULL)
        AND (verdict IS NULL) = (policy_category IS NULL)),
      CHECK(decision = 'ask' OR decided_by = 'outcome')
    )`,
    `CREATE TABLE run_model_usage (
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
      sample_id TEXT NOT NULL CHECK(length(sample_id) > 0),
      usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)), admitted_at TEXT, responded_at TEXT,
      PRIMARY KEY (run_id, sample_id)
    )`,
    `CREATE TABLE execution_budgets (
      budget_id TEXT PRIMARY KEY CHECK(length(budget_id) > 0),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
      tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
      token_limit INTEGER CHECK(token_limit IS NULL OR token_limit > 0),
      focus_id TEXT,
      focus_session_id TEXT
    )`,
    "ALTER TABLE execution_budgets ADD COLUMN task_item_id TEXT REFERENCES space_tasks(item_id) ON DELETE CASCADE",
    "CREATE UNIQUE INDEX idx_execution_budgets_task ON execution_budgets(task_item_id) WHERE task_item_id IS NOT NULL",
    "CREATE INDEX idx_chat_runs_budget ON chat_runs(json_extract(metadata_json, '$.run_policy.budget_id'))",
    "CREATE INDEX idx_chat_runs_task_item ON chat_runs(json_extract(metadata_json, '$.run_context.task.item_id'))",
    `CREATE TRIGGER chat_runs_delete_budget AFTER DELETE ON chat_runs
      BEGIN
        DELETE FROM execution_budgets
        WHERE budget_id = json_extract(OLD.metadata_json, '$.run_policy.budget_id')
          AND task_item_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_runs
            WHERE json_extract(metadata_json, '$.run_policy.budget_id') = execution_budgets.budget_id);
      END`,
    `CREATE TABLE session_todos (
      session_id TEXT NOT NULL,
      edited INTEGER NOT NULL CHECK(edited IN (0, 1)),
      items_json TEXT NOT NULL,
      explanation TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, edited)
    )`
  ]
} as const satisfies OperationalSchemaSection
