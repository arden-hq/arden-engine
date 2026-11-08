export const baselineStatements: ReadonlyArray<string> = [
  `CREATE TABLE model_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      settings_json TEXT CHECK(settings_json IS NULL OR (json_valid(settings_json) AND json_type(settings_json) = 'object'))
    )`,
  `INSERT INTO model_settings (singleton_id) VALUES (1)`,
  `CREATE TABLE tool_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      overrides_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(overrides_json) AND json_type(overrides_json) = 'object')
    )`,
  `INSERT INTO tool_settings (singleton_id) VALUES (1)`,
  `CREATE TABLE desks (
      desk_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      default_cwds TEXT NOT NULL DEFAULT '[]',
      instructions TEXT,
      instructions_source TEXT CHECK (instructions_source IN ('manual','generated') OR instructions_source IS NULL),
      page_path TEXT,
      page_id TEXT,
      autonomy TEXT,
      inference_policy TEXT NOT NULL DEFAULT '{"enabled":false}' CHECK(json_valid(inference_policy)),
      policy_generation INTEGER NOT NULL DEFAULT 0 CHECK(policy_generation >= 0),
      paused_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )`,
  `CREATE INDEX idx_desks_archived_updated ON desks(archived_at, updated_at DESC)`,
  `CREATE UNIQUE INDEX idx_desks_active_name_key ON desks(name_key) WHERE archived_at IS NULL`,
  `CREATE UNIQUE INDEX idx_desks_page_path ON desks(page_path) WHERE page_path IS NOT NULL`,
  `CREATE UNIQUE INDEX idx_desks_page_id ON desks(page_id) WHERE page_id IS NOT NULL`,
  `CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      public_ref TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_accessed_at TEXT,
      name TEXT,
      archived_at TEXT,
      session_type TEXT NOT NULL DEFAULT 'chat' CHECK(session_type IN ('chat', 'channel', 'agent')),
      origin_automation_id TEXT,
      parent_session_id TEXT,
      parent_run_id TEXT,
      parent_tool_call_id TEXT,
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE SET NULL,
      chat_model TEXT,
      context_generation INTEGER NOT NULL DEFAULT 0,
      active_message_count INTEGER NOT NULL DEFAULT 0,
      parent_message_id TEXT,
      has_unread INTEGER NOT NULL DEFAULT 0 CHECK(has_unread IN (0, 1)),
      visible_message_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      messages TEXT,
      CHECK(
        (session_type = 'agent'
          AND parent_session_id IS NOT NULL
          AND parent_run_id IS NOT NULL
          AND parent_tool_call_id IS NOT NULL
          AND parent_message_id IS NULL)
        OR
        (session_type <> 'agent'
          AND parent_run_id IS NULL
          AND parent_tool_call_id IS NULL)
      )
    )`,
  `CREATE INDEX idx_sessions_activity ON sessions(last_activity)`,
  `CREATE INDEX idx_sessions_archived ON sessions(archived_at)`,
  `CREATE TABLE session_messages (
      message_rowid INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_json TEXT NOT NULL,
      client_id TEXT,
      created_at TEXT NOT NULL,
      search_text TEXT,
      UNIQUE (session_id, message_id),
      UNIQUE (session_id, seq)
    )`,
  `CREATE INDEX idx_session_messages_client ON session_messages(session_id, client_id)`,
  `CREATE TABLE session_turns (
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      user_message_id TEXT NOT NULL,
      message_start_id TEXT NOT NULL,
      message_end_id TEXT NOT NULL,
      message_start_seq INTEGER NOT NULL,
      message_end_seq INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      PRIMARY KEY (session_id, turn_id),
      UNIQUE (session_id, turn_index)
    )`,
  `CREATE INDEX idx_session_turns_session_turn ON session_turns(session_id, turn_index)`,
  `CREATE INDEX idx_sessions_desk_activity ON sessions(desk_id, last_activity DESC)`,
  `CREATE INDEX idx_sessions_parent_activity ON sessions(parent_session_id, started_at)`,
  `CREATE UNIQUE INDEX idx_sessions_agent_origin
      ON sessions(parent_run_id, parent_tool_call_id)
      WHERE session_type = 'agent'`,
  `CREATE INDEX idx_sessions_list
      ON sessions(archived_at, session_type, last_activity DESC, session_id DESC)`,
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
  `CREATE INDEX idx_chat_runs_session_status ON chat_runs(session_id, status)`,
  `CREATE INDEX idx_chat_runs_session_latest ON chat_runs(session_id, updated_at DESC, started_at DESC, run_id DESC)`,
  `CREATE INDEX idx_chat_runs_session_origin ON chat_runs(session_id, json_extract(metadata_json, '$.run_context.origin'), started_at DESC, run_id DESC)`,
  `CREATE INDEX idx_chat_runs_recovery_status
      ON chat_runs(status)
      WHERE status IN ('pending', 'running', 'backgrounded', 'interrupted')`,
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
  `CREATE INDEX idx_chat_idempotency_run ON chat_idempotency_keys(run_id)`,
  `CREATE INDEX idx_chat_idempotency_expires ON chat_idempotency_keys(expires_at)`,
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
  `CREATE INDEX idx_session_queued_messages_session ON session_queued_messages(session_id, enqueued_at, client_id)`,
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
  `CREATE INDEX idx_tool_calls_session_started ON tool_calls(session_id, started_at)`,
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
  `CREATE INDEX idx_tool_approvals_run ON tool_approvals(run_id)`,
  `CREATE INDEX idx_tool_approvals_session_status ON tool_approvals(session_id, status)`,
  `CREATE TABLE run_model_usage (
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
      sample_id TEXT NOT NULL CHECK(length(sample_id) > 0),
      usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
      PRIMARY KEY (run_id, sample_id)
    )`,
  `CREATE TABLE execution_budgets (
      budget_id TEXT PRIMARY KEY CHECK(length(budget_id) > 0),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
      iterations_used INTEGER NOT NULL DEFAULT 0 CHECK(iterations_used >= 0),
      tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
      token_limit INTEGER CHECK(token_limit IS NULL OR token_limit > 0),
      focus_id TEXT,
      focus_session_id TEXT
    )`,
  `CREATE UNIQUE INDEX idx_execution_budgets_focus ON execution_budgets(focus_session_id, focus_id) WHERE focus_id IS NOT NULL`,
  `CREATE INDEX idx_chat_runs_budget ON chat_runs(json_extract(metadata_json, '$.run_policy.budget_id'))`,
  `CREATE INDEX idx_chat_runs_task_item ON chat_runs(json_extract(metadata_json, '$.run_context.task.item_id'))`,
  `CREATE TRIGGER chat_runs_delete_budget AFTER DELETE ON chat_runs
      BEGIN
        DELETE FROM execution_budgets
        WHERE budget_id = json_extract(OLD.metadata_json, '$.run_policy.budget_id')
          AND NOT EXISTS (SELECT 1 FROM session_focus WHERE focus_id = execution_budgets.focus_id
            AND session_id = execution_budgets.focus_session_id)
          AND NOT EXISTS (SELECT 1 FROM chat_runs
            WHERE json_extract(metadata_json, '$.run_policy.budget_id') = execution_budgets.budget_id);
      END`,
  `CREATE TABLE session_focus (
      session_id TEXT PRIMARY KEY,
      focus_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'blocked', 'budget_limited', 'complete')),
      evidence_json TEXT NOT NULL DEFAULT '[]',
      blocked_reason TEXT,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TRIGGER session_focus_delete_budget AFTER DELETE ON session_focus
      BEGIN
        DELETE FROM execution_budgets WHERE focus_id = OLD.focus_id AND focus_session_id = OLD.session_id
          AND NOT EXISTS (SELECT 1 FROM chat_runs
            WHERE json_extract(metadata_json, '$.run_policy.budget_id') = execution_budgets.budget_id);
      END`,
  `CREATE TABLE session_todo_overrides (
      session_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL,
      explanation TEXT,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE session_todos (
      session_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL,
      explanation TEXT,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE run_sidecars (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      context_manifest_json TEXT NOT NULL DEFAULT '[]',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE chat_compactions (
      compaction_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      boundary_seq INTEGER NOT NULL,
      messages_before INTEGER NOT NULL,
      messages_after INTEGER NOT NULL,
      rehydration_state TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, compaction_id)
    )`,
  `CREATE INDEX idx_chat_compactions_session_boundary ON chat_compactions(session_id, boundary_seq)`,
  `CREATE TABLE IF NOT EXISTS journal_streams (
      stream_id TEXT PRIMARY KEY,
      head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0),
      retained_from_sequence INTEGER CHECK (
        retained_from_sequence IS NULL OR
        (retained_from_sequence >= 1 AND retained_from_sequence <= head_sequence)
      )
    )`,
  `CREATE TABLE IF NOT EXISTS journal_records (
      stream_id TEXT NOT NULL REFERENCES journal_streams(stream_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_type TEXT NOT NULL CHECK (length(event_type) > 0),
      data_json TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (stream_id, sequence)
    )`,
  `CREATE TABLE session_event_checkpoints (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      checkpoint_seq INTEGER NOT NULL CHECK(checkpoint_seq >= 0)
    )`,
  `CREATE TABLE letter_subjects (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id)
    )`,
  `CREATE TABLE usage_daily (
      day TEXT NOT NULL CHECK(length(day) = 10),
      desk_id TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user', 'automation')),
      session_type TEXT NOT NULL CHECK(session_type IN ('chat', 'channel', 'agent')),
      model_id TEXT NOT NULL DEFAULT '',
      total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_tokens >= 0),
      runs INTEGER NOT NULL DEFAULT 0 CHECK(runs >= 0),
      PRIMARY KEY (day, desk_id, origin, session_type, model_id)
    )`,
  `CREATE TABLE transcript_search_clock (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      head_sequence INTEGER NOT NULL DEFAULT 0 CHECK(head_sequence >= 0)
    )`,
  `INSERT INTO transcript_search_clock (singleton_id, head_sequence) VALUES (1, 0)`,
  `CREATE TABLE transcript_search_source (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      source_id TEXT NOT NULL UNIQUE CHECK(length(source_id) = 32)
    )`,
  `INSERT INTO transcript_search_source (singleton_id, source_id) VALUES (1, lower(hex(randomblob(16))))`,
  `CREATE TABLE transcript_search_changes (
      sequence INTEGER PRIMARY KEY CHECK(sequence >= 1),
      message_rowid INTEGER NOT NULL
    )`,
  `CREATE TRIGGER session_messages_search_ai
      AFTER INSERT ON session_messages BEGIN
        UPDATE transcript_search_clock SET head_sequence = head_sequence + 1 WHERE singleton_id = 1;
        INSERT INTO transcript_search_changes(sequence, message_rowid)
        SELECT head_sequence, new.message_rowid FROM transcript_search_clock WHERE singleton_id = 1;
      END`,
  `CREATE TRIGGER session_messages_search_ad
      AFTER DELETE ON session_messages BEGIN
        UPDATE transcript_search_clock SET head_sequence = head_sequence + 1 WHERE singleton_id = 1;
        INSERT INTO transcript_search_changes(sequence, message_rowid)
        SELECT head_sequence, old.message_rowid FROM transcript_search_clock WHERE singleton_id = 1;
      END`,
  `CREATE TRIGGER session_messages_search_au
      AFTER UPDATE OF search_text ON session_messages BEGIN
        UPDATE transcript_search_clock SET head_sequence = head_sequence + 1 WHERE singleton_id = 1;
        INSERT INTO transcript_search_changes(sequence, message_rowid)
        SELECT head_sequence, new.message_rowid FROM transcript_search_clock WHERE singleton_id = 1;
      END`,
  `CREATE TABLE scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      automation_ref TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT,
      description_source TEXT CHECK (description_source IN ('manual', 'generated') OR description_source IS NULL),
      prompt TEXT NOT NULL,
      model TEXT,
      context_mode TEXT NOT NULL DEFAULT 'continue' CHECK(context_mode IN ('fresh', 'continue', 'fork')),
      triggers TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_run_at TEXT,
      next_run_at TEXT,
      last_result TEXT,
      running_since TEXT,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      handler TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      cooldown_minutes INTEGER,
      thread_id TEXT,
      idempotency_key TEXT,
      idempotency_scope TEXT,
      tool_scope TEXT NOT NULL DEFAULT 'read_only'
        CHECK(tool_scope IN ('read_only', 'reports', 'browser', 'all', 'desk', 'memory_capture', 'chat_summary')),
      triggers_source TEXT,
      purpose TEXT NOT NULL DEFAULT 'user_automation' CHECK(purpose IN ('user_automation', 'desk_review', 'task_execution', 'system')),
      owner_desk_id TEXT,
      owner_task_id TEXT,
      CHECK(purpose != 'user_automation' OR (thread_id IS NOT NULL AND context_mode IN ('fresh', 'continue'))),
      CHECK (
        (purpose = 'user_automation' AND owner_desk_id IS NULL AND owner_task_id IS NULL) OR
        (purpose = 'desk_review' AND owner_desk_id IS NOT NULL AND owner_task_id IS NULL) OR
        (purpose = 'task_execution' AND owner_desk_id IS NOT NULL AND owner_task_id IS NOT NULL) OR
        (purpose = 'system' AND owner_desk_id IS NULL AND owner_task_id IS NULL)
      )
    )`,
  `CREATE INDEX idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at)`,
  `CREATE INDEX idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)`,
  `CREATE INDEX idx_scheduled_tasks_idempotency
      ON scheduled_tasks(idempotency_scope, idempotency_key)
      WHERE idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX idx_scheduled_tasks_automation_ref ON scheduled_tasks(automation_ref)`,
  `CREATE TABLE automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      automation_ref TEXT,
      origin TEXT NOT NULL DEFAULT '{"kind":"unrecorded"}' CHECK(json_valid(origin)),
      item_id TEXT,
      task_generation INTEGER,
      purpose TEXT CHECK(purpose IS NULL OR purpose IN ('user_automation', 'desk_review', 'task_execution', 'system')),
      handler TEXT,
      context_mode TEXT NOT NULL DEFAULT 'continue' CHECK(context_mode IN ('fresh', 'continue', 'fork')),
      trigger_json TEXT CHECK(trigger_json IS NULL OR json_valid(trigger_json)),
      input_json TEXT CHECK(input_json IS NULL OR json_valid(input_json)),
      claim_count INTEGER NOT NULL DEFAULT 0 CHECK(claim_count >= 0),
      disposition TEXT CHECK(disposition IS NULL OR disposition IN ('completed', 'no_change', 'needs_you', 'skipped_no_input', 'superseded', 'failed')),
      chat_run_id TEXT,
      chat_session_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      result TEXT,
      error TEXT,
      CHECK((item_id IS NULL AND task_generation IS NULL) OR
        (item_id IS NOT NULL AND task_generation IS NOT NULL AND task_generation >= 0))
    )`,
  `CREATE INDEX idx_automation_runs_task ON automation_runs(task_id, started_at)`,
  `CREATE INDEX idx_automation_runs_ref ON automation_runs(automation_ref, started_at)`,
  `CREATE INDEX idx_automation_runs_item ON automation_runs(item_id, id DESC)`,
  `CREATE INDEX idx_automation_runs_result ON automation_runs(item_id, ended_at DESC, id DESC)
      WHERE ended_at IS NOT NULL AND length(trim(result)) > 0`,
  `CREATE UNIQUE INDEX idx_automation_runs_chat_run ON automation_runs(chat_run_id) WHERE chat_run_id IS NOT NULL`,
  `CREATE TRIGGER automation_runs_immutable_context
      BEFORE UPDATE OF origin, item_id, task_generation, purpose, handler, context_mode, trigger_json, input_json ON automation_runs
      WHEN NEW.origin IS NOT OLD.origin OR NEW.item_id IS NOT OLD.item_id
        OR NEW.task_generation IS NOT OLD.task_generation
        OR NEW.purpose IS NOT OLD.purpose OR NEW.handler IS NOT OLD.handler
        OR NEW.context_mode IS NOT OLD.context_mode
        OR NEW.trigger_json IS NOT OLD.trigger_json
        OR (OLD.input_json IS NOT NULL AND NEW.input_json IS NOT OLD.input_json)
      BEGIN
        SELECT RAISE(ABORT, 'Run origin and Task binding are immutable');
      END`,
  `CREATE TRIGGER chat_runs_immutable_context
      BEFORE UPDATE OF metadata_json ON chat_runs
      WHEN (json_extract(OLD.metadata_json, '$.run_context') IS NOT NULL
        AND json_extract(NEW.metadata_json, '$.run_context') IS NOT json_extract(OLD.metadata_json, '$.run_context'))
        OR (json_extract(OLD.metadata_json, '$.run_policy') IS NOT NULL
        AND json_extract(NEW.metadata_json, '$.run_policy') IS NOT json_extract(OLD.metadata_json, '$.run_policy'))
      BEGIN
        SELECT RAISE(ABORT, 'Run origin and Task binding are immutable');
      END`,
  `CREATE TRIGGER worker_attempt_state
      AFTER UPDATE OF status ON chat_runs
      BEGIN
        UPDATE automation_runs
        SET status = NEW.status,
          ended_at = NEW.ended_at,
          disposition = CASE WHEN NEW.status IN ('pending', 'running', 'backgrounded') THEN NULL
            WHEN NEW.status = 'completed' THEN CASE
              WHEN EXISTS (SELECT 1 FROM run_questions WHERE run_id = NEW.run_id AND resolution IS NULL AND closed_at IS NULL)
                THEN 'needs_you'
              WHEN json_extract(NEW.metadata_json, '$.no_change_reason') IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM tool_calls WHERE run_id = NEW.run_id AND changes_state = 1)
                AND NOT EXISTS (SELECT 1 FROM run_questions WHERE run_id = NEW.run_id) THEN 'no_change'
              ELSE 'completed' END
            ELSE 'failed' END,
          result = CASE WHEN NEW.status = 'completed' THEN COALESCE(
            json_extract(NEW.metadata_json, '$.terminal_result.text'),
            (SELECT json_extract(message_json, '$.content') FROM session_messages
              WHERE session_id = NEW.session_id AND message_id = NEW.assistant_message_id)
          ) ELSE NULL END,
          error = NEW.error_message
        WHERE chat_run_id = NEW.run_id AND task_id IS NULL;
      END`,
  `CREATE TABLE automation_deliveries (
      delivery_id TEXT PRIMARY KEY
        CHECK(length(delivery_id) = 64 AND delivery_id NOT GLOB '*[^0-9a-f]*'),
      task_id TEXT REFERENCES scheduled_tasks(task_id) ON DELETE SET NULL,
      delivered_at TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
      status TEXT NOT NULL DEFAULT 'delivered' CHECK(status IN ('pending', 'delivered', 'discarded')),
      created_at TEXT NOT NULL DEFAULT '',
      destinations TEXT NOT NULL
        CHECK(json_valid(destinations) AND json_type(destinations) = 'array')
    )`,
  `ALTER TABLE automation_deliveries ADD COLUMN
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0)`,
  `ALTER TABLE automation_deliveries ADD COLUMN next_attempt_at TEXT`,
  `ALTER TABLE automation_deliveries ADD COLUMN last_error TEXT`,
  `CREATE UNIQUE INDEX idx_automation_deliveries_question
      ON automation_deliveries(json_extract(payload, '$.questionId'))
      WHERE json_extract(payload, '$.kind') = 'answer'`,
  `CREATE INDEX idx_automation_deliveries_task
      ON automation_deliveries(task_id, delivered_at DESC, delivery_id)`,
  `CREATE INDEX idx_automation_deliveries_pending
      ON automation_deliveries(status, next_attempt_at, created_at, delivery_id)`,
  `CREATE TABLE delivery_incidents (
      incident_id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL UNIQUE
        REFERENCES automation_deliveries(delivery_id) ON DELETE CASCADE,
      code TEXT NOT NULL CHECK(code = 'delivery.unroutable'),
      summary TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX idx_delivery_incidents_created
      ON delivery_incidents(created_at DESC, incident_id)`,
  `CREATE TABLE automation_event_dedupe (
      task_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (task_id, event_key)
    )`,
  `CREATE INDEX idx_automation_event_dedupe_seen_at ON automation_event_dedupe(seen_at)`,
  `CREATE TABLE automation_idle_state (
      task_id TEXT PRIMARY KEY REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
      latest_input_sequence INTEGER NOT NULL CHECK(latest_input_sequence > 0),
      latest_input_at TEXT NOT NULL,
      consumed_input_sequence INTEGER NOT NULL DEFAULT 0 CHECK(consumed_input_sequence >= 0),
      CHECK(consumed_input_sequence <= latest_input_sequence)
    )`,
  `CREATE TABLE automation_event_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      source TEXT NOT NULL
        CHECK(source IN ('scheduled', 'manual', 'event', 'idle', 'count', 'wake')),
      event_key TEXT NOT NULL,
      context TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_event_at TEXT,
      not_before_at TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT
    )`,
  `CREATE INDEX idx_automation_event_queue_task_claimed_id
      ON automation_event_queue(task_id, claimed_at, id)`,
  `CREATE TABLE automation_count_state (
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      through_sequence INTEGER CHECK(through_sequence IS NULL OR through_sequence >= 0),
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, session_id)
    )`,
  `CREATE INDEX idx_automation_count_state_updated_at ON automation_count_state(updated_at)`,
  `CREATE TABLE automation_trigger_cursor (
      stream_id TEXT PRIMARY KEY,
      after_sequence INTEGER NOT NULL
    )`,
  `CREATE TABLE desk_tasks (
      item_id TEXT PRIMARY KEY,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      stable_key TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'deferred', 'done', 'cancelled')),
      owner TEXT NOT NULL CHECK(owner IN ('worker', 'user', 'external')),
      blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0, 1)),
      waiting_on TEXT,
      due_at TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      created_by TEXT,
      archived_at TEXT,
      body TEXT,
      seq INTEGER,
      block_count INTEGER NOT NULL DEFAULT 0,
      last_block_reason TEXT,
      capture TEXT NOT NULL DEFAULT '{"basis":"unrecorded","reason":null}' CHECK(json_valid(capture)),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
      UNIQUE(desk_id, stable_key),
      CHECK((blocked = 1 AND waiting_on IN ('you', 'external')) OR (blocked = 0 AND waiting_on IS NULL))
    )`,
  `CREATE TRIGGER task_revoke_attempts AFTER UPDATE OF status, owner, archived_at ON desk_tasks
      WHEN (NEW.status <> OLD.status AND NEW.status <> 'open')
        OR NEW.owner <> OLD.owner OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
      BEGIN
        UPDATE desk_tasks SET generation = OLD.generation + 1 WHERE item_id = NEW.item_id;
        UPDATE run_questions SET closed_at = NEW.updated_at
          WHERE resolution IS NULL AND closed_at IS NULL
            AND (NEW.status IN ('done', 'cancelled') OR NEW.archived_at IS NOT NULL OR NEW.owner <> OLD.owner)
            AND run_id IN (SELECT run_id FROM chat_runs
              WHERE json_extract(metadata_json, '$.run_context.task.item_id') = NEW.item_id);
        UPDATE automation_deliveries SET status = 'discarded',
          payload = json_set(payload, '$.withdrawal', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'reason', 'task_changed'))
          WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
            AND json_extract(payload, '$.context.task.item_id') = NEW.item_id;
      END`,
  `CREATE TRIGGER desk_revoke_task_attempts AFTER UPDATE OF paused_at, archived_at, autonomy, default_cwds, inference_policy ON desks
      WHEN (NEW.paused_at IS NOT NULL AND OLD.paused_at IS NULL)
        OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
        OR (OLD.autonomy = 'act' AND NEW.autonomy IS NOT 'act')
        OR (OLD.autonomy IS NOT NULL AND NEW.autonomy IS NULL)
        OR EXISTS (SELECT 1 FROM json_each(OLD.default_cwds) AS previous_folder
          WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.default_cwds) AS current_folder
            WHERE current_folder.value = previous_folder.value))
        OR (json_extract(OLD.inference_policy, '$.enabled') = 1 AND json_extract(NEW.inference_policy, '$.enabled') = 0)
      BEGIN
        UPDATE desks SET policy_generation = policy_generation + 1 WHERE desk_id = NEW.desk_id;
        UPDATE desk_tasks SET generation = generation + 1 WHERE desk_id = NEW.desk_id;
        UPDATE automation_deliveries SET status = 'discarded',
          payload = json_set(payload, '$.withdrawal', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'reason', 'desk_policy_changed'))
          WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
            AND json_extract(payload, '$.context.task.item_id') IN
              (SELECT item_id FROM desk_tasks WHERE desk_id = NEW.desk_id);
      END`,
  `CREATE INDEX idx_desk_tasks_desk_status
      ON desk_tasks(desk_id, status, updated_at DESC)`,
  `CREATE INDEX idx_desk_tasks_follow_up
      ON desk_tasks(next_attempt_at) WHERE next_attempt_at IS NOT NULL`,
  `CREATE TABLE desk_task_sources (
      item_id TEXT NOT NULL REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      source TEXT NOT NULL CHECK(json_valid(source)),
      created_at TEXT NOT NULL,
      PRIMARY KEY(item_id, source_key)
    )`,
  `CREATE INDEX idx_desk_task_sources_chat
      ON desk_task_sources(json_extract(source, '$.session_id'), item_id)
      WHERE json_extract(source, '$.kind') = 'chat'`,
  `CREATE TABLE desk_task_chats (
      item_id TEXT NOT NULL REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL,
      PRIMARY KEY(item_id, session_id)
    )`,
  `CREATE INDEX idx_desk_task_chats_session ON desk_task_chats(session_id, item_id)`,
  `CREATE TABLE desk_task_result_reads (
      item_id TEXT PRIMARY KEY REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      result_key TEXT NOT NULL,
      read_at TEXT NOT NULL
    )`,
  `CREATE TABLE desk_task_holds (
      item_id TEXT PRIMARY KEY REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES run_questions(question_id) ON DELETE RESTRICT,
      task_generation INTEGER NOT NULL CHECK(task_generation >= 0),
      acknowledged_at TEXT NOT NULL
    )`,
  `CREATE TRIGGER task_clear_hold AFTER UPDATE OF blocked, waiting_on, generation, status, archived_at ON desk_tasks
      WHEN NEW.blocked = 0 OR NEW.waiting_on IS NOT OLD.waiting_on OR NEW.generation <> OLD.generation
        OR NEW.status <> 'open' OR NEW.archived_at IS NOT NULL
      BEGIN
        DELETE FROM desk_task_holds WHERE item_id = NEW.item_id
          AND (NEW.blocked = 0 OR NEW.waiting_on IS NOT OLD.waiting_on
            OR NEW.status <> 'open' OR NEW.archived_at IS NOT NULL);
        UPDATE desk_task_holds SET task_generation = NEW.generation WHERE item_id = NEW.item_id;
      END`,
  `CREATE TABLE task_inference_rejections (
      item_id TEXT PRIMARY KEY,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      evidence_key TEXT NOT NULL,
      sources TEXT NOT NULL CHECK(json_valid(sources) AND json_type(sources) = 'array'),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX idx_task_inference_rejections_evidence ON task_inference_rejections(desk_id, evidence_key)`,
  `CREATE TABLE run_questions (
      question_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE RESTRICT,
      tool_call_id TEXT NOT NULL,
      content TEXT NOT NULL CHECK(json_valid(content)),
      resolution TEXT CHECK(resolution IS NULL OR json_valid(resolution)),
      closed_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, tool_call_id)
    )`,
  `CREATE INDEX idx_run_questions_run ON run_questions(run_id, created_at)`,
  `CREATE TABLE desk_task_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      item_id TEXT REFERENCES desk_tasks(item_id) ON DELETE SET NULL,
      run_ref TEXT,
      operation_index INTEGER,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      result_summary TEXT CHECK(result_summary IS NULL OR (length(trim(result_summary)) BETWEEN 1 AND 500)),
      content_kind TEXT NOT NULL DEFAULT 'summary' CHECK(content_kind = 'summary' OR (content_kind = 'result' AND event_type = 'done')),
      source_refs TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(run_ref, operation_index)
    )`,
  `CREATE INDEX idx_desk_task_events_desk_created
      ON desk_task_events(desk_id, created_at DESC)`,
  `CREATE INDEX idx_desk_task_events_result ON desk_task_events(item_id, created_at DESC, event_id DESC)
      WHERE content_kind = 'result'`,
  `CREATE TABLE desk_task_comments (
      comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      result_summary TEXT CHECK(result_summary IS NULL OR (length(trim(result_summary)) BETWEEN 1 AND 500)),
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','ask','result'))
    )`,
  `CREATE INDEX idx_desk_task_comments_desk_created
      ON desk_task_comments(desk_id, created_at DESC)`,
  `CREATE INDEX idx_desk_task_comments_result ON desk_task_comments(item_id, created_at DESC, comment_id DESC)
      WHERE kind = 'result'`,
  `CREATE TABLE desk_task_attachments (
      attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      data BLOB NOT NULL CHECK(typeof(data) = 'blob'),
      size INTEGER NOT NULL CHECK(size = length(data)) CHECK(size BETWEEN 1 AND 20971520),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX idx_desk_task_attachments_item
      ON desk_task_attachments(item_id, created_at)`,
  `CREATE TABLE home_presence (
      client_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL CHECK(sequence >= 0),
      last_seen_at TEXT,
      lease_until TEXT NOT NULL
    )`,
  `CREATE TABLE home_letter (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      window_id TEXT NOT NULL,
      window_since TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      source_fingerprint TEXT,
      run_id TEXT,
      generated_at TEXT,
      body_json TEXT CHECK(body_json IS NULL OR json_valid(body_json)),
      sources_json TEXT CHECK(sources_json IS NULL OR json_valid(sources_json)),
      snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
      CHECK ((run_id IS NULL AND source_fingerprint IS NULL AND generated_at IS NULL AND body_json IS NULL AND sources_json IS NULL AND snapshot_json IS NULL)
        OR (run_id IS NOT NULL AND source_fingerprint IS NOT NULL AND generated_at IS NOT NULL AND body_json IS NOT NULL AND sources_json IS NOT NULL AND snapshot_json IS NOT NULL))
    )`,
  `CREATE TABLE home_letters (
      letter_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      window_id TEXT NOT NULL,
      window_since TEXT NOT NULL,
      window_through TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      body_json TEXT NOT NULL CHECK(json_valid(body_json)),
      sources_json TEXT NOT NULL CHECK(json_valid(sources_json))
    )`,
  `CREATE TABLE inbox_reads (
      item_key TEXT PRIMARY KEY,
      read_at TEXT NOT NULL
    )`,
  `CREATE TABLE inbox_dismissals (
      item_key TEXT PRIMARY KEY,
      dismissed_at TEXT NOT NULL
    )`,
  `CREATE TABLE monitor_state (
      namespace TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE wiki_rename_approvals (
      approval_id TEXT PRIMARY KEY CHECK (length(approval_id) > 0),
      page_id TEXT NOT NULL CHECK (length(page_id) > 0),
      plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object'),
      status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'accepted', 'rejected')),
      created_at TEXT NOT NULL,
      commit_id TEXT,
      resolution TEXT,
      CHECK (
        (status IN ('pending', 'applying', 'rejected') AND commit_id IS NULL)
        OR (status = 'accepted' AND commit_id IS NOT NULL)
      )
    )`,
  `CREATE UNIQUE INDEX idx_wiki_rename_approvals_open_page
      ON wiki_rename_approvals(page_id)
      WHERE status IN ('pending', 'applying')`,
  `CREATE INDEX idx_wiki_rename_approvals_open_created
      ON wiki_rename_approvals(status, created_at)`,
  `CREATE TABLE storage_retention (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      agent_trace_days INTEGER CHECK(agent_trace_days IS NULL OR agent_trace_days BETWEEN 1 AND 3650),
      wiki_history_days INTEGER CHECK(wiki_history_days IS NULL OR wiki_history_days BETWEEN 1 AND 3650)
    )`,
  `CREATE TABLE storage_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      max_space_gib REAL CHECK(max_space_gib IS NULL OR max_space_gib BETWEEN 0.1 AND 1000000),
      allow_archived_session_deletion INTEGER NOT NULL DEFAULT 0
        CHECK(allow_archived_session_deletion IN (0, 1)),
      allow_inactive_session_deletion INTEGER NOT NULL DEFAULT 0
        CHECK(allow_inactive_session_deletion IN (0, 1)),
      inactive_session_days INTEGER NOT NULL DEFAULT 90
        CHECK(inactive_session_days BETWEEN 1 AND 3650),
      minimum_current_sessions INTEGER NOT NULL DEFAULT 100
        CHECK(minimum_current_sessions BETWEEN 1 AND 100000)
    )`,
  `INSERT INTO storage_settings (
      singleton_id, max_space_gib,
      allow_archived_session_deletion, allow_inactive_session_deletion,
      inactive_session_days, minimum_current_sessions
    ) VALUES (1, NULL, 0, 0, 90, 100)`,
  `CREATE TABLE session_file_cleanup (
      session_id TEXT PRIMARY KEY CHECK(length(session_id) > 0),
      queued_at TEXT NOT NULL
    )`,
  `CREATE TABLE managed_output_gc_candidates (
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      PRIMARY KEY(session_id, sha256)
    )`,
  `CREATE TABLE managed_output_lifecycle_lock (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0)
    )`,
  `CREATE TABLE workflows (
      workflow_ref TEXT PRIMARY KEY CHECK(length(workflow_ref) BETWEEN 1 AND 512),
      origin_session_ref TEXT NOT NULL
        REFERENCES sessions(public_ref) ON DELETE CASCADE
        CHECK(length(origin_session_ref) BETWEEN 1 AND 512),
      origin_run_id TEXT NOT NULL CHECK(length(origin_run_id) BETWEEN 1 AND 512),
      origin_tool_call_id TEXT NOT NULL CHECK(length(origin_tool_call_id) BETWEEN 1 AND 512),
      definition_hash TEXT NOT NULL CHECK(length(definition_hash) BETWEEN 1 AND 512),
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'needs_input', 'cancelling', 'succeeded',
        'failed', 'cancelled', 'needs_attention'
      )),
      version INTEGER NOT NULL CHECK(version >= 1),
      current_attempt INTEGER NOT NULL CHECK(current_attempt >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(origin_run_id, origin_tool_call_id),
      CHECK(updated_at >= created_at),
      CHECK(ended_at IS NULL OR ended_at >= created_at),
      CHECK(
        (status IN ('queued', 'running', 'needs_input', 'cancelling') AND ended_at IS NULL)
        OR
        (status IN ('succeeded', 'failed', 'cancelled', 'needs_attention') AND ended_at IS NOT NULL)
      )
    )`,
  `CREATE INDEX idx_workflows_status_updated
      ON workflows(status, updated_at)`,
  `CREATE INDEX idx_workflows_origin_session_status
      ON workflows(origin_session_ref, status)`,
  `CREATE TABLE workflow_attempts (
      workflow_ref TEXT NOT NULL REFERENCES workflows(workflow_ref) ON DELETE CASCADE,
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'needs_input', 'cancelling', 'succeeded',
        'failed', 'cancelled', 'needs_attention'
      )),
      retry_reuse TEXT NOT NULL CHECK(retry_reuse IN ('exact', 'none')),
      lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
      lease_token TEXT,
      worker_id TEXT,
      value_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(value_json)),
      error_json TEXT CHECK(error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
      retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0, 1)),
      source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
      result_ref TEXT,
      result_delivered_at TEXT,
      delivery_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempt_count >= 0),
      delivery_next_attempt_at TEXT,
      delivery_last_error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      PRIMARY KEY(workflow_ref, attempt),
      CHECK(
        (status = 'running'
          AND lease_token IS NOT NULL AND worker_id IS NOT NULL
          AND started_at IS NOT NULL AND ended_at IS NULL)
        OR
        (status <> 'running'
          AND lease_token IS NULL AND worker_id IS NULL)
      ),
      CHECK(ended_at IS NULL OR ended_at >= created_at),
      CHECK(result_delivered_at IS NULL OR result_delivered_at >= created_at)
    )`,
  `CREATE INDEX idx_workflow_attempts_status
      ON workflow_attempts(status)`,
  `CREATE TABLE workflow_nodes (
      workflow_ref TEXT NOT NULL REFERENCES workflows(workflow_ref) ON DELETE CASCADE,
      logical_key TEXT NOT NULL CHECK(length(logical_key) BETWEEN 1 AND 512),
      position INTEGER NOT NULL CHECK(position >= 0),
      label TEXT NOT NULL,
      phase TEXT,
      mode TEXT NOT NULL CHECK(mode IN ('research', 'code')),
      spec_hash TEXT NOT NULL CHECK(length(spec_hash) BETWEEN 1 AND 512),
      spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
      changes_state INTEGER NOT NULL CHECK(changes_state IN (0, 1)),
      created_at TEXT NOT NULL,
      PRIMARY KEY(workflow_ref, logical_key),
      UNIQUE(workflow_ref, position)
    )`,
  `CREATE TABLE workflow_node_attempts (
      workflow_ref TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      logical_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'needs_input', 'succeeded', 'failed',
        'cancelled', 'interrupted', 'uncertain'
      )),
      disposition TEXT NOT NULL CHECK(disposition IN ('launched', 'reused')),
      source_attempt INTEGER CHECK(source_attempt IS NULL OR source_attempt >= 1),
      child_attempts_json TEXT NOT NULL DEFAULT '[]' CHECK(
        json_valid(child_attempts_json)
        AND json_type(child_attempts_json) = 'array'
        AND json_array_length(child_attempts_json) <= 64
      ),
      value_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(value_json)),
      error_json TEXT CHECK(error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
      retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0, 1)),
      source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
      result_ref TEXT,
      started_at TEXT,
      ended_at TEXT,
      PRIMARY KEY(workflow_ref, attempt, logical_key),
      FOREIGN KEY(workflow_ref, attempt)
        REFERENCES workflow_attempts(workflow_ref, attempt) ON DELETE CASCADE,
      FOREIGN KEY(workflow_ref, logical_key)
        REFERENCES workflow_nodes(workflow_ref, logical_key) ON DELETE CASCADE,
      CHECK(
        (disposition = 'reused' AND status = 'succeeded' AND source_attempt IS NOT NULL
          AND started_at IS NOT NULL AND ended_at IS NOT NULL)
        OR
        (disposition = 'launched' AND source_attempt IS NULL)
      ),
      CHECK(ended_at IS NULL OR (started_at IS NOT NULL AND ended_at >= started_at))
    )`,
  `CREATE INDEX idx_workflow_node_attempts_page
      ON workflow_node_attempts(workflow_ref, attempt, logical_key)`,
  `CREATE INDEX idx_workflow_node_attempts_reuse
      ON workflow_node_attempts(workflow_ref, logical_key, status, attempt DESC)`,
  `CREATE TABLE workflow_operations (
      workflow_ref TEXT NOT NULL REFERENCES workflows(workflow_ref) ON DELETE CASCADE,
      operation_id TEXT NOT NULL CHECK(length(operation_id) = 36),
      kind TEXT NOT NULL CHECK(kind IN ('retry', 'cancel')),
      request_hash TEXT NOT NULL CHECK(length(request_hash) > 0),
      response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json) = 'object'),
      created_at TEXT NOT NULL,
      PRIMARY KEY(workflow_ref, operation_id)
    )`,
  `CREATE TABLE command_permissions (
      executable_path TEXT NOT NULL CHECK(length(executable_path) > 0),
      argument_prefix_json TEXT NOT NULL CHECK(json_valid(argument_prefix_json) AND json_type(argument_prefix_json) = 'array'),
      display_prefix TEXT NOT NULL CHECK(length(display_prefix) BETWEEN 1 AND 512),
      PRIMARY KEY (executable_path, argument_prefix_json)
    )`,
  `CREATE TABLE mcp_servers (
      name TEXT PRIMARY KEY,
      preset_id TEXT CHECK(preset_id IN (
        'github',
        'linear',
        'notion',
        'slack',
        'vercel'
      )),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      transport_json TEXT NOT NULL
        CHECK(json_valid(transport_json) AND json_type(transport_json) = 'object'),
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE standing_permissions (
      permission_id TEXT PRIMARY KEY CHECK(length(permission_id) > 0),
      principal TEXT NOT NULL CHECK(
        principal LIKE 'desk:%' OR principal LIKE 'automation:%'
      ),
      server_name TEXT NOT NULL REFERENCES mcp_servers(name) ON DELETE CASCADE,
      tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 256),
      granted_at TEXT NOT NULL
    )`,
  `CREATE UNIQUE INDEX idx_standing_permissions_identity
      ON standing_permissions(principal, tool_name)`,
  `CREATE INDEX idx_standing_permissions_server
      ON standing_permissions(server_name, granted_at DESC)`,
  `CREATE TABLE desk_review_checkpoints (
      desk_id TEXT PRIMARY KEY REFERENCES desks(desk_id) ON DELETE CASCADE,
      reviewed_input TEXT NOT NULL CHECK(json_valid(reviewed_input)),
      run_id TEXT REFERENCES chat_runs(run_id) ON DELETE SET NULL,
      reviewed_at TEXT NOT NULL
    )`,
  `CREATE TABLE discussion_offers (
      offer_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL REFERENCES sessions(session_id),
      source_turn_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL REFERENCES chat_runs(run_id),
      tool_call_id TEXT NOT NULL,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id),
      proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
      state TEXT NOT NULL CHECK(state IN ('offered', 'accepted', 'declined')),
      result_session_id TEXT REFERENCES sessions(session_id),
      created_at TEXT NOT NULL,
      UNIQUE(source_run_id, tool_call_id),
      CHECK((state = 'accepted') = (result_session_id IS NOT NULL))
    )`,
  `CREATE TABLE session_discussions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      offer_id TEXT NOT NULL UNIQUE REFERENCES discussion_offers(offer_id),
      source_session_id TEXT NOT NULL REFERENCES sessions(session_id),
      source_turn_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      context_json TEXT NOT NULL CHECK(json_valid(context_json))
    )`,
  `CREATE TABLE desk_conversations (
      desk_id TEXT PRIMARY KEY REFERENCES desks(desk_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE RESTRICT
    )`,
  `CREATE TRIGGER desk_conversation_binding BEFORE INSERT ON desk_conversations
      WHEN NOT EXISTS (
        SELECT 1 FROM sessions WHERE session_id = NEW.session_id
          AND desk_id = NEW.desk_id AND session_type = 'chat'
          AND parent_session_id IS NULL AND parent_message_id IS NULL
          AND archived_at IS NULL
      ) BEGIN SELECT RAISE(ABORT, 'Desk conversation must be an active ordinary chat in its Desk'); END`,
  `CREATE TRIGGER desk_conversation_session_guard
      BEFORE UPDATE OF desk_id, session_type, parent_session_id, parent_message_id, archived_at ON sessions
      WHEN EXISTS (SELECT 1 FROM desk_conversations WHERE session_id = OLD.session_id
        AND (NEW.desk_id IS NOT desk_id OR NEW.session_type != 'chat'
          OR NEW.parent_session_id IS NOT NULL OR NEW.parent_message_id IS NOT NULL
          OR NEW.archived_at IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'Desk conversation cannot be moved or archived separately'); END`,
  `CREATE TABLE chat_summaries (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK(length(title) > 0),
      summary TEXT NOT NULL CHECK(length(summary) > 0),
      topics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(topics_json) AND json_type(topics_json) = 'array'),
      through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
      run_id TEXT,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE desk_summaries (
      desk_id TEXT PRIMARY KEY REFERENCES desks(desk_id) ON DELETE CASCADE,
      now TEXT NOT NULL CHECK(length(now) > 0),
      next_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(next_json) AND json_type(next_json) = 'array'),
      recent TEXT,
      sources_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `ALTER TABLE automation_deliveries ADD COLUMN
      communication_sequence INTEGER CHECK(
        communication_sequence IS NULL OR communication_sequence > 0
      )`,
  `CREATE UNIQUE INDEX idx_automation_deliveries_communication_sequence
      ON automation_deliveries(communication_sequence)
      WHERE communication_sequence IS NOT NULL`,
  `CREATE INDEX idx_automation_deliveries_communication_desk
      ON automation_deliveries(
        json_extract(payload, '$.destinationDeskId'), communication_sequence
      )
      WHERE json_extract(payload, '$.kind') = 'communication'`,
  `CREATE TABLE communication_sequence_clock (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      current_sequence INTEGER NOT NULL CHECK(current_sequence >= 0)
    )`,
  `INSERT INTO communication_sequence_clock(singleton_id, current_sequence) VALUES(1, 0)`,
  `CREATE TABLE desk_continuity_seen (
      desk_id TEXT PRIMARY KEY REFERENCES desks(desk_id) ON DELETE CASCADE,
      state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
      arrivals_through INTEGER NOT NULL DEFAULT 0 CHECK(arrivals_through >= 0),
      task_events_through INTEGER NOT NULL DEFAULT 0 CHECK(task_events_through >= 0),
      question_changes_through INTEGER NOT NULL DEFAULT 0 CHECK(question_changes_through >= 0),
      last_acknowledgement_hash TEXT CHECK(
        last_acknowledgement_hash IS NULL OR (
          length(last_acknowledgement_hash) = 64 AND
          last_acknowledgement_hash NOT GLOB '*[^0-9a-f]*'
        )
      ),
      acknowledged_at TEXT
    )`,
  `CREATE TABLE desk_task_proposals (
      proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) > 0),
      dedupe_key TEXT NOT NULL UNIQUE CHECK(length(dedupe_key) > 0),
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      stable_key TEXT NOT NULL CHECK(length(stable_key) > 0),
      text TEXT NOT NULL CHECK(length(trim(text)) > 0),
      body TEXT,
      owner TEXT NOT NULL CHECK(owner IN ('worker', 'user', 'external')),
      capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
      sources_json TEXT NOT NULL CHECK(json_valid(sources_json) AND json_type(sources_json) = 'array'),
      evidence_revision_key TEXT NOT NULL CHECK(length(evidence_revision_key) > 0),
      candidate_hash TEXT NOT NULL CHECK(length(candidate_hash) > 0),
      source_run_id TEXT NOT NULL CHECK(length(source_run_id) > 0),
      source_session_id TEXT NOT NULL REFERENCES sessions(session_id) CHECK(length(source_session_id) > 0),
      source_turn_id TEXT NOT NULL CHECK(length(source_turn_id) > 0),
      source_tool_call_id TEXT NOT NULL CHECK(length(source_tool_call_id) > 0),
      capture_policy_json TEXT NOT NULL CHECK(json_valid(capture_policy_json)),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      status TEXT NOT NULL CHECK(status IN ('offered', 'accepted', 'rejected')),
      item_id TEXT REFERENCES desk_tasks(item_id),
      settlement_client_id TEXT,
      settlement_decision TEXT CHECK(settlement_decision IN ('accept', 'reject') OR settlement_decision IS NULL),
      settlement_task_json TEXT CHECK(settlement_task_json IS NULL OR json_valid(settlement_task_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      UNIQUE(desk_id, stable_key, dedupe_key),
      CHECK(updated_at >= created_at),
      CHECK((status = 'offered') = (settlement_client_id IS NULL AND settlement_decision IS NULL AND settlement_task_json IS NULL AND settled_at IS NULL AND item_id IS NULL)),
      CHECK(status != 'accepted' OR (settlement_decision = 'accept' AND item_id IS NOT NULL AND settlement_task_json IS NOT NULL)),
      CHECK(status != 'rejected' OR (settlement_decision = 'reject' AND item_id IS NULL AND settlement_task_json IS NULL))
    )`,
  `CREATE INDEX idx_task_proposals_desk_status
      ON desk_task_proposals(desk_id, status, updated_at DESC, proposal_id)`,
  `CREATE TABLE focus_choices (
      choice_id TEXT PRIMARY KEY CHECK(length(choice_id) > 0),
      question_id TEXT NOT NULL UNIQUE REFERENCES run_questions(question_id) ON DELETE RESTRICT,
      source_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      target_json TEXT NOT NULL CHECK(json_valid(target_json)),
      capture_policy_json TEXT NOT NULL CHECK(json_valid(capture_policy_json)),
      status TEXT NOT NULL CHECK(status IN ('offered', 'settled')),
      decision TEXT CHECK(decision IN ('continue_here', 'open_target') OR decision IS NULL),
      result_session_id TEXT REFERENCES sessions(session_id) ON DELETE RESTRICT,
      settlement_client_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK(updated_at >= created_at),
      CHECK((status = 'offered') = (decision IS NULL AND result_session_id IS NULL AND settlement_client_id IS NULL AND settled_at IS NULL)),
      CHECK(status != 'settled' OR (decision IS NOT NULL AND result_session_id IS NOT NULL AND settlement_client_id IS NOT NULL AND settled_at IS NOT NULL))
    )`,
  `CREATE INDEX idx_focus_choices_desk_status
      ON focus_choices(desk_id, status, updated_at DESC, choice_id)`
]
