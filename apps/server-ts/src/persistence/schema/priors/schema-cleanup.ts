import type { SchemaManifestRow } from "../manifest.js"

export const schemaCleanupPriorRows: ReadonlyArray<SchemaManifestRow> = [
  {
    type: "table",
    name: "desk_continuity_seen",
    tbl_name: "desk_continuity_seen",
    sql: `CREATE TABLE desk_continuity_seen (
      desk_id TEXT PRIMARY KEY REFERENCES desks(desk_id) ON DELETE CASCADE,
      state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
      arrivals_through INTEGER NOT NULL DEFAULT 0 CHECK(arrivals_through >= 0),
      task_events_through INTEGER NOT NULL DEFAULT 0 CHECK(task_events_through >= 0),
      question_changes_through INTEGER NOT NULL DEFAULT 0 CHECK(question_changes_through >= 0),
      report_id TEXT REFERENCES desk_letter_reports(report_id) ON DELETE RESTRICT,
      report_revision INTEGER CHECK(report_revision IS NULL OR report_revision > 0),
      last_acknowledgement_hash TEXT CHECK(
        last_acknowledgement_hash IS NULL OR (
          length(last_acknowledgement_hash) = 64 AND
          last_acknowledgement_hash NOT GLOB '*[^0-9a-f]*'
        )
      ),
      acknowledged_at TEXT,
      CHECK((report_id IS NULL) = (report_revision IS NULL))
    )`
  },
  {
    type: "table",
    name: "desk_letter_reports",
    tbl_name: "desk_letter_reports",
    sql: `CREATE TABLE desk_letter_reports (
      report_id TEXT PRIMARY KEY
        CHECK(length(report_id) = 64 AND report_id NOT GLOB '*[^0-9a-f]*'),
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      destination_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision > 0),
      slot_at TEXT NOT NULL,
      slot_timezone TEXT NOT NULL,
      arrivals_through INTEGER NOT NULL CHECK(arrivals_through >= 0),
      task_events_through INTEGER NOT NULL CHECK(task_events_through >= 0),
      question_changes_through INTEGER NOT NULL CHECK(question_changes_through >= 0),
      base_state_version INTEGER NOT NULL CHECK(base_state_version >= 0),
      payload TEXT NOT NULL CHECK(json_valid(payload)),
      message_id TEXT NOT NULL,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(desk_id, message_id)
    )`
  },
  {
    type: "index",
    name: "idx_desk_letter_reports_current",
    tbl_name: "desk_letter_reports",
    sql: `CREATE UNIQUE INDEX idx_desk_letter_reports_current
      ON desk_letter_reports(desk_id)
      WHERE acknowledged_at IS NULL`
  },
  {
    type: "table",
    name: "outbox_events",
    tbl_name: "outbox_events",
    sql: `CREATE TABLE outbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'run.completed',
        'run.failed',
        'automation.settled',
        'wiki.projection.requested'
      )),
      aggregate_type TEXT,
      aggregate_id TEXT,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TEXT NOT NULL,
      locked_at TEXT,
      locked_by TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      receipt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (receipt_at IS NULL OR status = 'completed'),
      CHECK (locked_by IS NULL OR length(locked_by) > 0),
      CHECK (lease_token IS NULL OR length(lease_token) > 0),
      CHECK (lease_expires_at IS NULL OR length(lease_expires_at) > 0),
      CHECK (
        (status = 'running'
          AND locked_at IS NOT NULL
          AND locked_by IS NOT NULL
          AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'running'
          AND locked_at IS NULL
          AND locked_by IS NULL
          AND lease_token IS NULL
          AND lease_expires_at IS NULL)
      )
    )`
  },
  {
    type: "index",
    name: "idx_outbox_events_aggregate",
    tbl_name: "outbox_events",
    sql: `CREATE INDEX idx_outbox_events_aggregate
      ON outbox_events(aggregate_type, aggregate_id)`
  },
  {
    type: "index",
    name: "idx_outbox_events_lease_expiry",
    tbl_name: "outbox_events",
    sql: `CREATE INDEX idx_outbox_events_lease_expiry
      ON outbox_events(lease_expires_at, id)
      WHERE status = 'running'`
  },
  {
    type: "index",
    name: "idx_outbox_events_ready",
    tbl_name: "outbox_events",
    sql: `CREATE INDEX idx_outbox_events_ready
      ON outbox_events(status, available_at, id)`
  },
  {
    type: "table",
    name: "scheduled_tasks",
    tbl_name: "scheduled_tasks",
    sql: `CREATE TABLE scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      automation_ref TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT,
      description_source TEXT CHECK (description_source IN ('manual', 'generated') OR description_source IS NULL),
      prompt TEXT NOT NULL,
      model TEXT,
      context_mode TEXT NOT NULL DEFAULT 'continue' CHECK(context_mode IN ('fresh', 'continue')),
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
      kind TEXT NOT NULL DEFAULT 'automation' CHECK(kind IN ('automation', 'agent')),
      thread_id TEXT,
      execution_session_id TEXT,
      idempotency_key TEXT,
      idempotency_scope TEXT,
      tool_scope TEXT NOT NULL DEFAULT 'read_only'
        CHECK(tool_scope IN ('read_only', 'reports', 'browser', 'all', 'desk', 'memory_capture')),
      triggers_source TEXT,
      purpose TEXT NOT NULL DEFAULT 'user_automation' CHECK(purpose IN ('user_automation', 'desk_review', 'task_execution', 'system')),
      owner_desk_id TEXT,
      owner_task_id TEXT,
      CHECK(purpose != 'user_automation' OR execution_session_id IS NOT NULL),
      CHECK (
        (purpose = 'user_automation' AND owner_task_id IS NULL) OR
        (purpose = 'desk_review' AND owner_desk_id IS NOT NULL AND owner_task_id IS NULL) OR
        (purpose = 'task_execution' AND owner_desk_id IS NOT NULL AND owner_task_id IS NOT NULL) OR
        (purpose = 'system' AND owner_desk_id IS NULL AND owner_task_id IS NULL)
      )
    )`
  },
  {
    type: "table",
    name: "storage_backup_pins",
    tbl_name: "storage_backup_pins",
    sql: `CREATE TABLE storage_backup_pins (
      backup_name TEXT PRIMARY KEY CHECK(length(backup_name) BETWEEN 1 AND 255),
      kept_at TEXT NOT NULL
    )`
  },
  {
    type: "table",
    name: "storage_settings",
    tbl_name: "storage_settings",
    sql: `CREATE TABLE storage_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      max_space_gib REAL CHECK(max_space_gib IS NULL OR max_space_gib BETWEEN 0.1 AND 1000000),
      backup_retention_days INTEGER NOT NULL DEFAULT 14
        CHECK(backup_retention_days BETWEEN 1 AND 3650),
      allow_archived_session_deletion INTEGER NOT NULL DEFAULT 0
        CHECK(allow_archived_session_deletion IN (0, 1)),
      allow_inactive_session_deletion INTEGER NOT NULL DEFAULT 0
        CHECK(allow_inactive_session_deletion IN (0, 1)),
      inactive_session_days INTEGER NOT NULL DEFAULT 90
        CHECK(inactive_session_days BETWEEN 1 AND 3650),
      minimum_current_sessions INTEGER NOT NULL DEFAULT 100
        CHECK(minimum_current_sessions BETWEEN 1 AND 100000)
    )`
  },
  {
    type: "table",
    name: "workflow_attempts",
    tbl_name: "workflow_attempts",
    sql: `CREATE TABLE workflow_attempts (
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
      lease_expires_at TEXT,
      value_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(value_json)),
      error_json TEXT CHECK(error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
      retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0, 1)),
      source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
      result_ref TEXT,
      result_delivered_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      PRIMARY KEY(workflow_ref, attempt),
      CHECK(
        (status = 'running'
          AND lease_token IS NOT NULL AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL
          AND started_at IS NOT NULL AND ended_at IS NULL)
        OR
        (status <> 'running'
          AND lease_token IS NULL AND worker_id IS NULL AND lease_expires_at IS NULL)
      ),
      CHECK(ended_at IS NULL OR ended_at >= created_at),
      CHECK(result_delivered_at IS NULL OR result_delivered_at >= created_at)
    )`
  },
  {
    type: "index",
    name: "idx_workflow_attempts_status",
    tbl_name: "workflow_attempts",
    sql: `CREATE INDEX idx_workflow_attempts_status
      ON workflow_attempts(status, lease_expires_at)`
  }
]
