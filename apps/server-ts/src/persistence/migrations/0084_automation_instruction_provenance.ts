import type { Migration } from "./index.js"

export const automationInstructionProvenance: Migration = {
  version: 84,
  name: "automation_instruction_provenance",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE automation_instruction_revisions (
      revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      instruction_json TEXT NOT NULL CHECK(json_valid(instruction_json)),
      instruction_hash TEXT NOT NULL CHECK(length(instruction_hash) = 64),
      prompt_author TEXT CHECK(prompt_author IN ('owner', 'agent')),
      source_run_id TEXT,
      source_tool_call_id TEXT,
      written_at TEXT NOT NULL,
      CHECK((source_run_id IS NULL) = (source_tool_call_id IS NULL))
    )`)
    database.exec(
      "CREATE INDEX idx_automation_instruction_revisions_task ON automation_instruction_revisions(task_id, revision_id)"
    )
    database.exec(`CREATE TRIGGER automation_instruction_revisions_immutable_update
      BEFORE UPDATE ON automation_instruction_revisions
      BEGIN SELECT RAISE(ABORT, 'Automation instruction revisions are immutable'); END`)
    database.exec(`CREATE TRIGGER automation_instruction_revisions_immutable_delete
      BEFORE DELETE ON automation_instruction_revisions
      BEGIN SELECT RAISE(ABORT, 'Automation instruction revisions are immutable'); END`)
    database.exec(`CREATE TABLE automation_instruction_candidates (
      automation_ref TEXT PRIMARY KEY,
      call_rowid INTEGER NOT NULL,
      source_run_id TEXT NOT NULL,
      source_tool_call_id TEXT NOT NULL
    )`)
    database.exec("ALTER TABLE scheduled_tasks ADD COLUMN instruction_revision_id INTEGER")
    database.exec("ALTER TABLE automation_runs ADD COLUMN instruction_revision_id INTEGER")
    database.exec("DROP TRIGGER automation_runs_immutable_context")
    database.exec(`CREATE TRIGGER automation_runs_immutable_context
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
      END`)
  }
}
