import type { OperationalSchemaSection } from "../section.js"

export const workSchemaSection = {
  name: "work",
  storageDomain: "work",
  tables: [
    "space_tasks",
    "space_task_sources",
    "space_task_result_reads",
    "space_task_holds",
    "task_inference_rejections",
    "run_questions",
    "run_question_timers",
    "space_task_events",
    "space_task_comments",
    "space_task_attachments"
  ],
  indexes: [
    "idx_space_tasks_space_status",
    "idx_space_tasks_follow_up",
    "idx_space_tasks_chat_key",
    "idx_space_tasks_free_key",
    "idx_space_tasks_home",
    "idx_space_tasks_in_chat",
    "idx_space_task_sources_chat",
    "idx_task_inference_rejections_evidence",
    "idx_run_questions_run",
    "idx_run_question_timers_pending",
    "idx_space_task_events_space_created",
    "idx_space_task_events_result",
    "idx_space_task_comments_space_created",
    "idx_space_task_attachments_item"
  ],
  triggers: ["task_revoke_attempts", "space_revoke_task_attempts", "task_clear_hold"],
  statements: [
    `CREATE TABLE space_tasks (
      item_id TEXT PRIMARY KEY,
      space_id TEXT REFERENCES spaces(space_id) ON DELETE CASCADE,
      home_session_id TEXT REFERENCES sessions(session_id),
      stable_key TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'deferred', 'done', 'cancelled')),
      owner TEXT NOT NULL CHECK(owner IN ('worker', 'user', 'external')),
      runs_in TEXT NOT NULL DEFAULT 'background' CHECK(runs_in IN ('chat', 'background')),
      token_budget INTEGER CHECK(token_budget IS NULL OR token_budget > 0),
      blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0, 1)),
      waiting_on TEXT,
      due_at TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      created_by TEXT,
      body TEXT,
      seq INTEGER,
      block_count INTEGER NOT NULL DEFAULT 0,
      last_block_reason TEXT,
      capture TEXT NOT NULL DEFAULT '{"basis":"unrecorded","reason":null}' CHECK(json_valid(capture)),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
      continuation_context TEXT, origin_message_id TEXT, original_body TEXT,
      UNIQUE(space_id, stable_key),
      CHECK((blocked = 1 AND waiting_on IN ('you', 'external')) OR (blocked = 0 AND waiting_on IS NULL)),
      CHECK(runs_in = 'background' OR home_session_id IS NOT NULL)
    )`,
    `CREATE TRIGGER task_revoke_attempts AFTER UPDATE OF status, owner ON space_tasks
      WHEN (NEW.status <> OLD.status AND NEW.status <> 'open')
        OR NEW.owner <> OLD.owner
      BEGIN
        UPDATE space_tasks SET generation = OLD.generation + 1 WHERE item_id = NEW.item_id;
        UPDATE run_questions SET closed_at = NEW.updated_at
          WHERE resolution IS NULL AND closed_at IS NULL
            AND (NEW.status IN ('done', 'cancelled') OR NEW.owner <> OLD.owner)
            AND run_id IN (SELECT run_id FROM chat_runs
              WHERE json_extract(metadata_json, '$.run_context.task.item_id') = NEW.item_id);
        UPDATE deferred_tool_calls SET status = 'rejected', resolved_at = NEW.updated_at
          WHERE status = 'pending'
            AND (NEW.status IN ('done', 'cancelled') OR NEW.owner <> OLD.owner)
            AND run_id IN (SELECT run_id FROM chat_runs
              WHERE json_extract(metadata_json, '$.run_context.task.item_id') = NEW.item_id);
        UPDATE automation_deliveries SET status = 'discarded',
          payload = json_set(payload, '$.withdrawal', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'reason', 'task_changed'))
          WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
            AND json_extract(payload, '$.context.task.item_id') = NEW.item_id;
      END`,
    `CREATE TRIGGER space_revoke_task_attempts AFTER UPDATE OF archived_at, inference_policy ON spaces
      WHEN (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
        OR (json_extract(OLD.inference_policy, '$.enabled') = 1 AND json_extract(NEW.inference_policy, '$.enabled') = 0)
      BEGIN
        UPDATE spaces SET policy_generation = policy_generation + 1 WHERE space_id = NEW.space_id;
        UPDATE space_tasks SET generation = generation + 1 WHERE space_id = NEW.space_id;
        UPDATE automation_deliveries SET status = 'discarded',
          payload = json_set(payload, '$.withdrawal', json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'reason', 'space_policy_changed'))
          WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
            AND json_extract(payload, '$.context.task.item_id') IN
              (SELECT item_id FROM space_tasks WHERE space_id = NEW.space_id);
      END`,
    `CREATE INDEX idx_space_tasks_space_status
      ON space_tasks(space_id, status, updated_at DESC)`,
    `CREATE INDEX idx_space_tasks_follow_up
      ON space_tasks(next_attempt_at) WHERE next_attempt_at IS NOT NULL`,
    `CREATE UNIQUE INDEX idx_space_tasks_chat_key
      ON space_tasks(home_session_id, stable_key) WHERE space_id IS NULL AND home_session_id IS NOT NULL`,
    `CREATE UNIQUE INDEX idx_space_tasks_free_key
      ON space_tasks(stable_key) WHERE space_id IS NULL AND home_session_id IS NULL`,
    `CREATE INDEX idx_space_tasks_home
      ON space_tasks(home_session_id, status) WHERE home_session_id IS NOT NULL`,
    `CREATE UNIQUE INDEX idx_space_tasks_in_chat
      ON space_tasks(home_session_id)
      WHERE runs_in = 'chat' AND status IN ('open', 'deferred')`,
    `CREATE TABLE space_task_sources (
      item_id TEXT NOT NULL REFERENCES space_tasks(item_id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      source TEXT NOT NULL CHECK(json_valid(source)),
      created_at TEXT NOT NULL,
      PRIMARY KEY(item_id, source_key)
    )`,
    `CREATE INDEX idx_space_task_sources_chat
      ON space_task_sources(json_extract(source, '$.session_id'), item_id)
      WHERE json_extract(source, '$.kind') = 'chat'`,
    `CREATE TABLE space_task_result_reads (
      item_id TEXT PRIMARY KEY REFERENCES space_tasks(item_id) ON DELETE CASCADE,
      result_key TEXT NOT NULL,
      read_at TEXT NOT NULL
    )`,
    `CREATE TABLE space_task_holds (
      item_id TEXT PRIMARY KEY REFERENCES space_tasks(item_id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES run_questions(question_id) ON DELETE RESTRICT,
      task_generation INTEGER NOT NULL CHECK(task_generation >= 0),
      acknowledged_at TEXT NOT NULL
    )`,
    `CREATE TRIGGER task_clear_hold AFTER UPDATE OF blocked, waiting_on, generation, status ON space_tasks
      WHEN NEW.blocked = 0 OR NEW.waiting_on IS NOT OLD.waiting_on OR NEW.generation <> OLD.generation
        OR NEW.status <> 'open'
      BEGIN
        DELETE FROM space_task_holds WHERE item_id = NEW.item_id
          AND (NEW.blocked = 0 OR NEW.waiting_on IS NOT OLD.waiting_on
            OR NEW.status <> 'open');
        UPDATE space_task_holds SET task_generation = NEW.generation WHERE item_id = NEW.item_id;
      END`,
    `CREATE TABLE task_inference_rejections (
      item_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
      evidence_key TEXT NOT NULL,
      sources TEXT NOT NULL CHECK(json_valid(sources) AND json_type(sources) = 'array'),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    "CREATE INDEX idx_task_inference_rejections_evidence ON task_inference_rejections(space_id, evidence_key)",
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
    "CREATE INDEX idx_run_questions_run ON run_questions(run_id, created_at)",
    `CREATE TABLE run_question_timers (
      question_id TEXT PRIMARY KEY REFERENCES run_questions(question_id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      seconds INTEGER NOT NULL CHECK(seconds > 0),
      fallback_choice_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'elapsed', 'cancelled'))
    )`,
    "CREATE INDEX idx_run_question_timers_pending ON run_question_timers(expires_at) WHERE status = 'pending'",
    `CREATE TABLE space_task_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id TEXT REFERENCES spaces(space_id) ON DELETE CASCADE,
      item_id TEXT REFERENCES space_tasks(item_id) ON DELETE SET NULL,
      run_ref TEXT,
      operation_index INTEGER,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      result_summary TEXT CHECK(result_summary IS NULL OR (length(trim(result_summary)) BETWEEN 1 AND 500)),
      content_kind TEXT NOT NULL DEFAULT 'summary' CHECK(content_kind = 'summary' OR (content_kind = 'result' AND event_type = 'done')),
      source_refs TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, stop_cause TEXT
      CHECK(stop_cause IN ('request_invalid', 'run_interrupted', 'provider_unavailable', 'rate_limited', 'stalled', 'failed')), state_version INTEGER,
      UNIQUE(run_ref, operation_index)
    )`,
    `CREATE INDEX idx_space_task_events_space_created
      ON space_task_events(space_id, created_at DESC)`,
    `CREATE INDEX idx_space_task_events_result ON space_task_events(item_id, created_at DESC, event_id DESC)
      WHERE content_kind = 'result'`,
    `CREATE TABLE space_task_comments (
      comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id TEXT REFERENCES spaces(space_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES space_tasks(item_id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','ask'))
    )`,
    `CREATE INDEX idx_space_task_comments_space_created
      ON space_task_comments(space_id, created_at DESC)`,
    `CREATE TABLE space_task_attachments (
      attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id TEXT REFERENCES spaces(space_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES space_tasks(item_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      data BLOB NOT NULL CHECK(typeof(data) = 'blob'),
      size INTEGER NOT NULL CHECK(size = length(data)) CHECK(size BETWEEN 1 AND 20971520),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_space_task_attachments_item
      ON space_task_attachments(item_id, created_at)`
  ]
} as const satisfies OperationalSchemaSection
