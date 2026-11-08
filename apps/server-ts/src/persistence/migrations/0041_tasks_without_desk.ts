import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const tasksWithoutDesk: Migration = {
  version: 41,
  name: "tasks_without_desk",
  foreignKeys: {
    kind: "rebuilds",
    tables: [
      "desk_tasks",
      "desk_task_events",
      "desk_task_comments",
      "desk_task_attachments",
      "scheduled_tasks"
    ]
  },
  up: (database) => {
    deferUnstartedTasks(database)
    // Renaming a parent table aside must leave the REFERENCES text of its child
    database.exec("PRAGMA legacy_alter_table = ON")
    try {
      rebuild(database, "desk_tasks", deskTasks, deskTaskColumns, [
        taskRevokeAttempts,
        taskClearHold,
        deskTasksDeskStatusIndex,
        deskTasksFollowUpIndex,
        deskTasksChatKeyIndex,
        deskTasksFreeKeyIndex,
        deskTasksHomeIndex
      ])
      rebuild(database, "desk_task_events", deskTaskEvents, deskTaskEventColumns, [
        deskTaskEventsDeskCreatedIndex,
        deskTaskEventsResultIndex
      ])
      rebuild(database, "desk_task_comments", deskTaskComments, deskTaskCommentColumns, [
        deskTaskCommentsDeskCreatedIndex
      ])
      rebuild(database, "desk_task_attachments", deskTaskAttachments, deskTaskAttachmentColumns, [
        deskTaskAttachmentsItemIndex
      ])
      rebuild(database, "scheduled_tasks", scheduledTasks, scheduledTaskColumns, [
        scheduledTasksNextRunIndex,
        scheduledTasksEnabledIndex,
        scheduledTasksIdempotencyIndex,
        scheduledTasksAutomationRefIndex
      ])
    } finally {
      database.exec("PRAGMA legacy_alter_table = OFF")
    }
    database.exec("DROP TRIGGER desk_revoke_task_attempts")
    database.exec(deskRevokeTaskAttempts)
  }
}

const deferUnstartedTasks = (database: DatabaseSync): void => {
  const now = new Date().toISOString()
  const unstarted = database
    .prepare(
      `SELECT task.item_id, task.desk_id FROM desk_tasks AS task
      JOIN desks AS desk ON desk.desk_id = task.desk_id
      WHERE task.status = 'open' AND task.owner = 'worker' AND task.archived_at IS NULL
        AND desk.autonomy IS NOT 'act'`
    )
    .all()
  const defer = database.prepare(
    "UPDATE desk_tasks SET status = 'deferred', updated_at = ? WHERE item_id = ?"
  )
  const note = database.prepare(
    `INSERT INTO desk_task_events (desk_id, item_id, event_type, summary, created_at)
    VALUES (?, ?, 'updated', 'Kept, not started. Reopen it to let Arden work on it.', ?)`
  )
  for (const row of unstarted) {
    defer.run(now, String(row.item_id))
    note.run(String(row.desk_id), String(row.item_id), now)
  }
}

const rebuild = (
  database: DatabaseSync,
  table: string,
  create: string,
  columns: ReadonlyArray<string>,
  dependents: ReadonlyArray<string>
): void => {
  const prior = `${table}_prior`
  database.exec(`ALTER TABLE "${table}" RENAME TO "${prior}"`)
  database.exec(create)
  const list = columns.join(", ")
  database.exec(`INSERT INTO "${table}" (rowid, ${list}) SELECT rowid, ${list} FROM "${prior}"`)
  database.exec(`DROP TABLE "${prior}"`)
  for (const statement of dependents) database.exec(statement)
}

const deskTaskColumns = [
  "item_id",
  "desk_id",
  "stable_key",
  "text",
  "status",
  "owner",
  "blocked",
  "waiting_on",
  "due_at",
  "next_attempt_at",
  "created_at",
  "updated_at",
  "completed_at",
  "created_by",
  "archived_at",
  "body",
  "seq",
  "block_count",
  "last_block_reason",
  "capture",
  "generation",
  "continuation_context"
]

const deskTasks = `CREATE TABLE desk_tasks (
      item_id TEXT PRIMARY KEY,
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
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
      archived_at TEXT,
      body TEXT,
      seq INTEGER,
      block_count INTEGER NOT NULL DEFAULT 0,
      last_block_reason TEXT,
      capture TEXT NOT NULL DEFAULT '{"basis":"unrecorded","reason":null}' CHECK(json_valid(capture)),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
      continuation_context TEXT,
      UNIQUE(desk_id, stable_key),
      CHECK((blocked = 1 AND waiting_on IN ('you', 'external')) OR (blocked = 0 AND waiting_on IS NULL)),
      CHECK(runs_in = 'background' OR home_session_id IS NOT NULL)
    )`

const taskRevokeAttempts = `CREATE TRIGGER task_revoke_attempts AFTER UPDATE OF status, owner, archived_at ON desk_tasks
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
      END`

const taskClearHold = `CREATE TRIGGER task_clear_hold AFTER UPDATE OF blocked, waiting_on, generation, status, archived_at ON desk_tasks
      WHEN NEW.blocked = 0 OR NEW.waiting_on IS NOT OLD.waiting_on OR NEW.generation <> OLD.generation
        OR NEW.status <> 'open' OR NEW.archived_at IS NOT NULL
      BEGIN
        DELETE FROM desk_task_holds WHERE item_id = NEW.item_id
          AND (NEW.blocked = 0 OR NEW.waiting_on IS NOT OLD.waiting_on
            OR NEW.status <> 'open' OR NEW.archived_at IS NOT NULL);
        UPDATE desk_task_holds SET task_generation = NEW.generation WHERE item_id = NEW.item_id;
      END`

const deskTasksDeskStatusIndex = `CREATE INDEX idx_desk_tasks_desk_status
      ON desk_tasks(desk_id, status, updated_at DESC)`

const deskTasksFollowUpIndex = `CREATE INDEX idx_desk_tasks_follow_up
      ON desk_tasks(next_attempt_at) WHERE next_attempt_at IS NOT NULL`

// SQLite treats NULLs as distinct in UNIQUE(desk_id, stable_key), so a Task
const deskTasksChatKeyIndex = `CREATE UNIQUE INDEX idx_desk_tasks_chat_key
      ON desk_tasks(home_session_id, stable_key) WHERE desk_id IS NULL AND home_session_id IS NOT NULL`

const deskTasksFreeKeyIndex = `CREATE UNIQUE INDEX idx_desk_tasks_free_key
      ON desk_tasks(stable_key) WHERE desk_id IS NULL AND home_session_id IS NULL`

const deskTasksHomeIndex = `CREATE INDEX idx_desk_tasks_home
      ON desk_tasks(home_session_id, status) WHERE home_session_id IS NOT NULL`

const deskRevokeTaskAttempts = `CREATE TRIGGER desk_revoke_task_attempts AFTER UPDATE OF paused_at, archived_at, default_cwds, inference_policy ON desks
      WHEN (NEW.paused_at IS NOT NULL AND OLD.paused_at IS NULL)
        OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
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
      END`

const deskTaskEventColumns = [
  "event_id",
  "desk_id",
  "item_id",
  "run_ref",
  "operation_index",
  "event_type",
  "summary",
  "result_summary",
  "content_kind",
  "source_refs",
  "created_at"
]

const deskTaskEvents = `CREATE TABLE desk_task_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
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
    )`

const deskTaskEventsDeskCreatedIndex = `CREATE INDEX idx_desk_task_events_desk_created
      ON desk_task_events(desk_id, created_at DESC)`

const deskTaskEventsResultIndex = `CREATE INDEX idx_desk_task_events_result ON desk_task_events(item_id, created_at DESC, event_id DESC)
      WHERE content_kind = 'result'`

const deskTaskCommentColumns = [
  "comment_id",
  "desk_id",
  "item_id",
  "author",
  "body",
  "created_at",
  "kind"
]

const deskTaskComments = `CREATE TABLE desk_task_comments (
      comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','ask'))
    )`

const deskTaskCommentsDeskCreatedIndex = `CREATE INDEX idx_desk_task_comments_desk_created
      ON desk_task_comments(desk_id, created_at DESC)`

const deskTaskAttachmentColumns = [
  "attachment_id",
  "desk_id",
  "item_id",
  "name",
  "media_type",
  "data",
  "size",
  "created_by",
  "created_at"
]

const deskTaskAttachments = `CREATE TABLE desk_task_attachments (
      attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES desk_tasks(item_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      data BLOB NOT NULL CHECK(typeof(data) = 'blob'),
      size INTEGER NOT NULL CHECK(size = length(data)) CHECK(size BETWEEN 1 AND 20971520),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`

const deskTaskAttachmentsItemIndex = `CREATE INDEX idx_desk_task_attachments_item
      ON desk_task_attachments(item_id, created_at)`

const scheduledTaskColumns = [
  "task_id",
  "automation_ref",
  "name",
  "description",
  "description_source",
  "prompt",
  "model",
  "context_mode",
  "triggers",
  "enabled",
  "created_at",
  "last_run_at",
  "next_run_at",
  "last_result",
  "running_since",
  "auto_approve",
  "handler",
  "builtin",
  "cooldown_minutes",
  "thread_id",
  "idempotency_key",
  "idempotency_scope",
  "tool_scope",
  "triggers_source",
  "purpose",
  "owner_desk_id",
  "owner_task_id",
  "followup_generation"
]

const scheduledTasks = `CREATE TABLE scheduled_tasks (
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
      followup_generation INTEGER NOT NULL DEFAULT 0,
      CHECK(purpose != 'user_automation' OR (thread_id IS NOT NULL AND context_mode IN ('fresh', 'continue'))),
      CHECK (
        (purpose = 'user_automation' AND owner_desk_id IS NULL AND owner_task_id IS NULL) OR
        (purpose = 'desk_review' AND owner_desk_id IS NOT NULL AND owner_task_id IS NULL) OR
        (purpose = 'task_execution' AND owner_task_id IS NOT NULL) OR
        (purpose = 'system' AND owner_desk_id IS NULL AND owner_task_id IS NULL)
      )
    )`

const scheduledTasksNextRunIndex =
  "CREATE INDEX idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at)"

const scheduledTasksEnabledIndex =
  "CREATE INDEX idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)"

const scheduledTasksIdempotencyIndex = `CREATE INDEX idx_scheduled_tasks_idempotency
      ON scheduled_tasks(idempotency_scope, idempotency_key)
      WHERE idempotency_key IS NOT NULL`

const scheduledTasksAutomationRefIndex =
  "CREATE UNIQUE INDEX idx_scheduled_tasks_automation_ref ON scheduled_tasks(automation_ref)"
