import type { Migration } from "./index.js"
const statements = [
  "ALTER TABLE standing_permissions ADD COLUMN source_run_id TEXT",
  "ALTER TABLE standing_permissions ADD COLUMN source_tool_call_id TEXT",
  "ALTER TABLE command_permissions ADD COLUMN source_run_id TEXT",
  "ALTER TABLE command_permissions ADD COLUMN source_tool_call_id TEXT",
  `CREATE TABLE permission_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      permission_kind TEXT NOT NULL CHECK(permission_kind IN ('standing', 'command', 'override')),
      permission_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('baseline', 'granted', 'revoked', 'changed')),
      principal TEXT,
      server_name TEXT,
      tool_name TEXT,
      argument_count INTEGER CHECK(argument_count IS NULL OR argument_count >= 0),
      previous_mode TEXT,
      next_mode TEXT,
      source_question_id TEXT,
      source_session_id TEXT,
      source_run_id TEXT,
      source_tool_call_id TEXT,
      occurred_at TEXT,
      recorded_at TEXT NOT NULL,
      CHECK((source_run_id IS NULL) = (source_tool_call_id IS NULL)),
      CHECK((permission_kind = 'override') = (permission_id IS NULL)),
      CHECK(permission_kind != 'override' OR (tool_name IS NOT NULL AND action IN ('baseline', 'changed'))),
      CHECK(permission_kind != 'command' OR argument_count IS NOT NULL)
    )`,
  `CREATE INDEX idx_permission_changes_permission
      ON permission_changes(permission_kind, permission_id, change_id)`,
  `CREATE TRIGGER standing_permission_granted AFTER INSERT ON standing_permissions BEGIN
      INSERT INTO permission_changes (
        permission_kind, permission_id, action, principal, server_name, tool_name,
        source_question_id, source_session_id, source_run_id, source_tool_call_id,
        occurred_at, recorded_at
      ) VALUES (
        'standing', NEW.permission_id, 'granted', NEW.principal, NEW.server_name, NEW.tool_name,
        NEW.source_question_id,
        COALESCE((SELECT session_id FROM permission_offers WHERE question_id = NEW.source_question_id),
          (SELECT session_id FROM chat_runs WHERE run_id = NEW.source_run_id)),
        NEW.source_run_id, NEW.source_tool_call_id, NEW.granted_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    END`,
  `CREATE TRIGGER standing_permission_revoked BEFORE DELETE ON standing_permissions BEGIN
      INSERT INTO permission_changes (
        permission_kind, permission_id, action, principal, server_name, tool_name,
        source_question_id, source_session_id, source_run_id, source_tool_call_id,
        occurred_at, recorded_at
      ) VALUES (
        'standing', OLD.permission_id, 'revoked', OLD.principal, OLD.server_name, OLD.tool_name,
        OLD.source_question_id,
        (SELECT source_session_id FROM permission_changes
          WHERE permission_kind = 'standing' AND permission_id = OLD.permission_id
          ORDER BY change_id LIMIT 1),
        OLD.source_run_id, OLD.source_tool_call_id,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    END`,
  `CREATE TRIGGER command_permission_granted AFTER INSERT ON command_permissions BEGIN
      INSERT INTO permission_changes (
        permission_kind, permission_id, action, argument_count,
        source_session_id, source_run_id, source_tool_call_id, occurred_at, recorded_at
      ) VALUES (
        'command', NEW.permission_id, 'granted', json_array_length(NEW.argument_prefix_json),
        (SELECT session_id FROM chat_runs WHERE run_id = NEW.source_run_id),
        NEW.source_run_id, NEW.source_tool_call_id, NEW.granted_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    END`,
  `CREATE TRIGGER command_permission_revoked BEFORE DELETE ON command_permissions BEGIN
      INSERT INTO permission_changes (
        permission_kind, permission_id, action, argument_count,
        source_session_id, source_run_id, source_tool_call_id, occurred_at, recorded_at
      ) VALUES (
        'command', OLD.permission_id, 'revoked', json_array_length(OLD.argument_prefix_json),
        (SELECT source_session_id FROM permission_changes
          WHERE permission_kind = 'command' AND permission_id = OLD.permission_id
          ORDER BY change_id LIMIT 1),
        OLD.source_run_id, OLD.source_tool_call_id,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    END`,
  `CREATE TABLE question_decisions (
      decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('answered', 'closed', 'baseline_answered', 'baseline_closed')),
      answer_kind TEXT,
      choice_id TEXT,
      choice_ids_json TEXT CHECK(choice_ids_json IS NULL OR
        (json_valid(choice_ids_json) AND json_type(choice_ids_json) = 'array')),
      occurred_at TEXT,
      recorded_at TEXT NOT NULL,
      UNIQUE(question_id, kind)
    )`,
  `CREATE INDEX idx_question_decisions_question
      ON question_decisions(question_id, decision_id)`,
  `CREATE TRIGGER question_answer_recorded AFTER UPDATE OF resolution ON run_questions
      WHEN OLD.resolution IS NULL AND NEW.resolution IS NOT NULL BEGIN
      INSERT INTO question_decisions (question_id, session_id, run_id, tool_call_id,
        kind, answer_kind, choice_id, choice_ids_json, occurred_at, recorded_at)
      VALUES (NEW.question_id, (SELECT session_id FROM chat_runs WHERE run_id = NEW.run_id),
        NEW.run_id, NEW.tool_call_id, 'answered',
        json_extract(NEW.resolution, '$.answer.kind'),
        CASE WHEN json_extract(NEW.resolution, '$.answer.kind') = 'choice'
          THEN json_extract(NEW.resolution, '$.answer.choice_id') ELSE NULL END,
        CASE WHEN json_extract(NEW.resolution, '$.answer.kind') = 'choices'
            AND json_array_length(NEW.resolution, '$.answer.choice_ids') BETWEEN 1 AND 6
          THEN json_extract(NEW.resolution, '$.answer.choice_ids') ELSE NULL END,
        json_extract(NEW.resolution, '$.resolved_at'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END`,
  `CREATE TRIGGER question_closure_recorded AFTER UPDATE OF closed_at ON run_questions
      WHEN OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL BEGIN
      INSERT INTO question_decisions (question_id, session_id, run_id, tool_call_id, kind, occurred_at, recorded_at)
      VALUES (NEW.question_id, (SELECT session_id FROM chat_runs WHERE run_id = NEW.run_id),
        NEW.run_id, NEW.tool_call_id, 'closed', NEW.closed_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END`,
  `CREATE TRIGGER question_decision_before_delete BEFORE DELETE ON run_questions BEGIN
      INSERT INTO question_decisions (question_id, session_id, run_id, tool_call_id,
        kind, answer_kind, choice_id, choice_ids_json, occurred_at, recorded_at)
      SELECT OLD.question_id, (SELECT session_id FROM chat_runs WHERE run_id = OLD.run_id),
        OLD.run_id, OLD.tool_call_id, 'baseline_answered',
        json_extract(OLD.resolution, '$.answer.kind'),
        CASE WHEN json_extract(OLD.resolution, '$.answer.kind') = 'choice'
          THEN json_extract(OLD.resolution, '$.answer.choice_id') ELSE NULL END,
        CASE WHEN json_extract(OLD.resolution, '$.answer.kind') = 'choices'
            AND json_array_length(OLD.resolution, '$.answer.choice_ids') BETWEEN 1 AND 6
          THEN json_extract(OLD.resolution, '$.answer.choice_ids') ELSE NULL END,
        json_extract(OLD.resolution, '$.resolved_at'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE OLD.resolution IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM question_decisions WHERE question_id = OLD.question_id
          AND kind IN ('answered', 'baseline_answered'));
      INSERT INTO question_decisions (question_id, session_id, run_id, tool_call_id, kind, occurred_at, recorded_at)
      SELECT OLD.question_id, (SELECT session_id FROM chat_runs WHERE run_id = OLD.run_id),
        OLD.run_id, OLD.tool_call_id, 'baseline_closed', OLD.closed_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE OLD.closed_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM question_decisions WHERE question_id = OLD.question_id
          AND kind IN ('closed', 'baseline_closed'));
    END`,
  `CREATE TABLE tool_approval_decisions (
      decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('resolved', 'baseline')),
      status TEXT NOT NULL CHECK(status IN ('approved', 'rejected')),
      requested_at TEXT NOT NULL,
      resolved_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )`,
  `CREATE INDEX idx_tool_approval_decisions_call
      ON tool_approval_decisions(run_id, tool_call_id, decision_id)`,
  `CREATE TRIGGER tool_approval_decision_recorded AFTER UPDATE OF status ON tool_approvals
      WHEN OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') AND NEW.kind = 'tool_approval' BEGIN
      INSERT INTO tool_approval_decisions
        (run_id, tool_call_id, session_id, tool_name, kind, status, requested_at, resolved_at, recorded_at)
      VALUES (NEW.run_id, NEW.tool_call_id, NEW.session_id, NEW.tool_name, 'resolved',
        NEW.status, NEW.requested_at, NEW.resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END`,
  `CREATE TRIGGER tool_approval_decision_before_reuse BEFORE UPDATE OF status ON tool_approvals
      WHEN OLD.status IN ('approved', 'rejected') AND NEW.status = 'pending' AND OLD.kind = 'tool_approval' BEGIN
      INSERT INTO tool_approval_decisions
        (run_id, tool_call_id, session_id, tool_name, kind, status, requested_at, resolved_at, recorded_at)
      SELECT OLD.run_id, OLD.tool_call_id, OLD.session_id, OLD.tool_name, 'baseline',
        OLD.status, OLD.requested_at, OLD.resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE NOT EXISTS (SELECT 1 FROM tool_approval_decisions
        WHERE run_id = OLD.run_id AND tool_call_id = OLD.tool_call_id);
    END`,
  `CREATE TRIGGER tool_approval_decision_before_delete BEFORE DELETE ON tool_approvals
      WHEN OLD.status IN ('approved', 'rejected') AND OLD.kind = 'tool_approval' BEGIN
      INSERT INTO tool_approval_decisions
        (run_id, tool_call_id, session_id, tool_name, kind, status, requested_at, resolved_at, recorded_at)
      SELECT OLD.run_id, OLD.tool_call_id, OLD.session_id, OLD.tool_name, 'baseline',
        OLD.status, OLD.requested_at, OLD.resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE NOT EXISTS (SELECT 1 FROM tool_approval_decisions
        WHERE run_id = OLD.run_id AND tool_call_id = OLD.tool_call_id);
    END`,
  `CREATE TRIGGER permission_changes_immutable BEFORE UPDATE ON permission_changes
      BEGIN SELECT RAISE(ABORT, 'Permission history is immutable'); END`,
  `CREATE TRIGGER question_decisions_immutable BEFORE UPDATE ON question_decisions
      BEGIN SELECT RAISE(ABORT, 'Question decision receipts are immutable'); END`,
  `CREATE TRIGGER tool_approval_decisions_immutable BEFORE UPDATE ON tool_approval_decisions
      BEGIN SELECT RAISE(ABORT, 'Approval decision receipts are immutable'); END`
]

export const authorityHistory: Migration = {
  version: 87,
  name: "authority_history",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const statement of statements) database.exec(statement)
    database.exec(`INSERT INTO permission_changes (
      permission_kind, permission_id, action, principal, server_name, tool_name,
      source_question_id, source_session_id, occurred_at, recorded_at
    ) SELECT 'standing', permission_id, 'baseline', principal, server_name, tool_name,
      source_question_id,
      (SELECT session_id FROM permission_offers WHERE question_id = source_question_id),
      granted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM standing_permissions`)
    database.exec(`INSERT INTO permission_changes (
      permission_kind, permission_id, action, argument_count, occurred_at, recorded_at
    ) SELECT 'command', permission_id, 'baseline', json_array_length(argument_prefix_json),
      granted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM command_permissions`)
    database.exec(`INSERT INTO permission_changes (
      permission_kind, action, tool_name, next_mode, recorded_at
    ) SELECT 'override', 'baseline', key, value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM tool_settings, json_each(tool_settings.overrides_json)
      WHERE singleton_id = 1`)
  }
}
