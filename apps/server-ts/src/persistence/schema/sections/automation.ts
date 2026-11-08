import { quietRunSql } from "../run-change.js"
import type { OperationalSchemaSection } from "../section.js"

export const automationSchemaSection = {
  name: "automation",
  storageDomain: "automation",
  tables: [
    "scheduled_tasks",
    "automation_instruction_revisions",
    "automation_instruction_candidates",
    "automation_runs",
    "automation_deliveries",
    "delivery_incidents",
    "automation_event_dedupe",
    "automation_event_queue",
    "automation_count_state",
    "automation_idle_state",
    "automation_trigger_cursor"
  ],
  indexes: [
    "idx_scheduled_tasks_next_run",
    "idx_scheduled_tasks_enabled",
    "idx_scheduled_tasks_idempotency",
    "idx_scheduled_tasks_automation_ref",
    "idx_automation_instruction_revisions_task",
    "idx_automation_runs_task",
    "idx_automation_runs_status_task",
    "idx_automation_runs_ref",
    "idx_automation_runs_item",
    "idx_automation_runs_result",
    "idx_automation_runs_chat_run",
    "idx_automation_runs_chat_session",
    "idx_automation_deliveries_task",
    "idx_automation_deliveries_pending",
    "idx_automation_deliveries_question",
    "idx_delivery_incidents_created",
    "idx_automation_event_dedupe_seen_at",
    "idx_automation_event_queue_task_claimed_id",
    "idx_automation_count_state_updated_at"
  ],
  triggers: [
    "automation_instruction_revisions_immutable_update",
    "automation_instruction_revisions_immutable_delete",
    "automation_runs_immutable_context",
    "chat_runs_immutable_context",
    "worker_attempt_state"
  ],
  statements: [
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
        CHECK(tool_scope IN ('read_only', 'reports', 'browser', 'all', 'space', 'memory_capture', 'chat_summary')),
      triggers_source TEXT,
      purpose TEXT NOT NULL DEFAULT 'user_automation' CHECK(purpose IN ('user_automation', 'space_review', 'task_execution', 'system')),
      owner_space_id TEXT,
      owner_task_id TEXT,
      followup_generation INTEGER NOT NULL DEFAULT 0,
      CHECK(purpose != 'user_automation' OR (thread_id IS NOT NULL AND context_mode IN ('fresh', 'continue'))),
      CHECK (
        (purpose = 'user_automation' AND owner_space_id IS NULL AND owner_task_id IS NULL) OR
        (purpose = 'space_review' AND owner_space_id IS NOT NULL AND owner_task_id IS NULL) OR
        (purpose = 'task_execution' AND owner_task_id IS NOT NULL) OR
        (purpose = 'system' AND owner_space_id IS NULL AND owner_task_id IS NULL)
      )
    )`,
    "CREATE INDEX idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at)",
    "CREATE INDEX idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)",
    `CREATE INDEX idx_scheduled_tasks_idempotency
      ON scheduled_tasks(idempotency_scope, idempotency_key)
      WHERE idempotency_key IS NOT NULL`,
    "CREATE UNIQUE INDEX idx_scheduled_tasks_automation_ref ON scheduled_tasks(automation_ref)",
    "ALTER TABLE scheduled_tasks ADD COLUMN trigger_last_id INTEGER NOT NULL DEFAULT 0 CHECK(trigger_last_id >= 0)",
    "ALTER TABLE scheduled_tasks ADD COLUMN prompt_author TEXT CHECK(prompt_author IN ('owner', 'agent'))",
    "ALTER TABLE scheduled_tasks ADD COLUMN instruction_revision_id INTEGER",
    "ALTER TABLE scheduled_tasks ADD COLUMN paused_at TEXT",
    `CREATE TABLE automation_instruction_revisions (
      revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      instruction_json TEXT NOT NULL CHECK(json_valid(instruction_json)),
      instruction_hash TEXT NOT NULL CHECK(length(instruction_hash) = 64),
      prompt_author TEXT CHECK(prompt_author IN ('owner', 'agent')),
      source_run_id TEXT,
      source_tool_call_id TEXT,
      written_at TEXT NOT NULL,
      CHECK((source_run_id IS NULL) = (source_tool_call_id IS NULL))
    )`,
    "CREATE INDEX idx_automation_instruction_revisions_task ON automation_instruction_revisions(task_id, revision_id)",
    `CREATE TRIGGER automation_instruction_revisions_immutable_update
      BEFORE UPDATE ON automation_instruction_revisions
      BEGIN SELECT RAISE(ABORT, 'Automation instruction revisions are immutable'); END`,
    `CREATE TRIGGER automation_instruction_revisions_immutable_delete
      BEFORE DELETE ON automation_instruction_revisions
      BEGIN SELECT RAISE(ABORT, 'Automation instruction revisions are immutable'); END`,
    `CREATE TABLE automation_instruction_candidates (
      automation_ref TEXT PRIMARY KEY,
      call_rowid INTEGER NOT NULL,
      source_run_id TEXT NOT NULL,
      source_tool_call_id TEXT NOT NULL
    )`,
    `CREATE TABLE automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      automation_ref TEXT,
      origin TEXT NOT NULL DEFAULT '{"kind":"unrecorded"}' CHECK(json_valid(origin)),
      item_id TEXT,
      task_generation INTEGER,
      purpose TEXT CHECK(purpose IS NULL OR purpose IN ('user_automation', 'space_review', 'task_execution', 'system')),
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
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
      result TEXT,
      error TEXT, followup_json TEXT CHECK(followup_json IS NULL OR json_valid(followup_json)),
      CHECK((item_id IS NULL AND task_generation IS NULL) OR
        (item_id IS NOT NULL AND task_generation IS NOT NULL AND task_generation >= 0))
    )`,
    "ALTER TABLE automation_runs ADD COLUMN skip_json TEXT CHECK(skip_json IS NULL OR json_valid(skip_json))",
    `ALTER TABLE automation_runs ADD COLUMN outcome TEXT CHECK(outcome IS NULL OR outcome IN (
      'finished', 'no_change', 'needs_you', 'blocked', 'failed', 'interrupted', 'cancelled',
      'superseded', 'skipped:prefilter', 'skipped:space_review_gate'))`,
    "ALTER TABLE automation_runs ADD COLUMN instruction_revision_id INTEGER",
    "CREATE INDEX idx_automation_runs_task ON automation_runs(task_id, started_at)",
    `CREATE INDEX idx_automation_runs_status_task
      ON automation_runs(status, task_id, started_at)`,
    "CREATE INDEX idx_automation_runs_ref ON automation_runs(automation_ref, started_at)",
    "CREATE INDEX idx_automation_runs_item ON automation_runs(item_id, id DESC)",
    `CREATE INDEX idx_automation_runs_result ON automation_runs(item_id, ended_at DESC, id DESC)
      WHERE ended_at IS NOT NULL AND length(trim(result)) > 0`,
    "CREATE UNIQUE INDEX idx_automation_runs_chat_run ON automation_runs(chat_run_id) WHERE chat_run_id IS NOT NULL",
    "CREATE INDEX idx_automation_runs_chat_session ON automation_runs(chat_session_id)",
    `CREATE TRIGGER automation_runs_immutable_context
      BEFORE UPDATE OF origin, item_id, task_generation, purpose, handler, context_mode,
        trigger_json, input_json, instruction_revision_id ON automation_runs
      WHEN NEW.origin IS NOT OLD.origin OR NEW.item_id IS NOT OLD.item_id
        OR NEW.task_generation IS NOT OLD.task_generation
        OR NEW.purpose IS NOT OLD.purpose OR NEW.handler IS NOT OLD.handler
        OR NEW.context_mode IS NOT OLD.context_mode
        OR NEW.trigger_json IS NOT OLD.trigger_json
        OR NEW.instruction_revision_id IS NOT OLD.instruction_revision_id
        OR (OLD.input_json IS NOT NULL AND NEW.input_json IS NOT OLD.input_json)
      BEGIN
        SELECT RAISE(ABORT, 'Run origin and Task binding are immutable');
      END`,
    `CREATE TRIGGER chat_runs_immutable_context
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
      END`,
    `CREATE TRIGGER worker_attempt_state
      AFTER UPDATE OF status ON chat_runs
      BEGIN
        UPDATE automation_runs
        SET status = CASE WHEN NEW.status IN ('pending', 'running', 'backgrounded') THEN 'running'
            WHEN NEW.status IN ('completed', 'cancelled', 'interrupted') THEN NEW.status
            ELSE 'failed' END,
          ended_at = NEW.ended_at,
          disposition = CASE WHEN NEW.status IN ('pending', 'running', 'backgrounded') THEN NULL
            WHEN NEW.status = 'completed' THEN CASE
              WHEN EXISTS (SELECT 1 FROM run_questions WHERE run_id = NEW.run_id AND resolution IS NULL AND closed_at IS NULL)
                THEN 'needs_you'
              WHEN ${quietRunSql("NEW.run_id", "NEW.metadata_json")} THEN 'no_change'
              ELSE 'completed' END
            ELSE 'failed' END,
          result = CASE WHEN NEW.status = 'completed' THEN COALESCE(
            json_extract(NEW.metadata_json, '$.terminal_result.text'),
            (SELECT json_extract(message_json, '$.content') FROM session_messages
              WHERE session_id = NEW.session_id AND message_id = NEW.assistant_message_id)
          ) ELSE NULL END,
          error = NEW.error_message
        WHERE chat_run_id = NEW.run_id AND task_id IS NULL;
        UPDATE automation_runs
        SET outcome = CASE WHEN status = 'running' THEN NULL
            WHEN status IN ('failed', 'cancelled', 'interrupted') THEN status
            WHEN disposition = 'needs_you' THEN 'needs_you'
            WHEN EXISTS (SELECT 1 FROM run_sidecars AS sidecar WHERE sidecar.run_id = automation_runs.chat_run_id
              AND json_extract(sidecar.evidence_json, '$.automation_outcome') IS NOT NULL) THEN 'blocked'
            WHEN disposition = 'no_change' THEN 'no_change'
            ELSE 'finished' END
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
    "ALTER TABLE automation_deliveries ADD COLUMN next_attempt_at TEXT",
    "ALTER TABLE automation_deliveries ADD COLUMN last_error TEXT",
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
    "CREATE INDEX idx_automation_event_dedupe_seen_at ON automation_event_dedupe(seen_at)",
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
    "CREATE INDEX idx_automation_count_state_updated_at ON automation_count_state(updated_at)",
    `CREATE TABLE automation_trigger_cursor (
      stream_id TEXT PRIMARY KEY,
      after_sequence INTEGER NOT NULL
    )`
  ]
} as const satisfies OperationalSchemaSection
