import type { Migration } from "./index.js"

export const inChatTasks: Migration = {
  version: 42,
  name: "in_chat_tasks",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE execution_budgets ADD COLUMN task_item_id TEXT REFERENCES desk_tasks(item_id) ON DELETE CASCADE"
    )
    database.exec(
      "CREATE UNIQUE INDEX idx_execution_budgets_task ON execution_budgets(task_item_id) WHERE task_item_id IS NOT NULL"
    )
    database.exec("DROP TRIGGER chat_runs_delete_budget")
    database.exec(chatRunsDeleteBudget)
    database.exec(desksTasksInChat)
  }
}

const chatRunsDeleteBudget = `CREATE TRIGGER chat_runs_delete_budget AFTER DELETE ON chat_runs
      BEGIN
        DELETE FROM execution_budgets
        WHERE budget_id = json_extract(OLD.metadata_json, '$.run_policy.budget_id')
          AND task_item_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM session_focus WHERE focus_id = execution_budgets.focus_id
            AND session_id = execution_budgets.focus_session_id)
          AND NOT EXISTS (SELECT 1 FROM chat_runs
            WHERE json_extract(metadata_json, '$.run_policy.budget_id') = execution_budgets.budget_id);
      END`

const desksTasksInChat = `CREATE UNIQUE INDEX idx_desk_tasks_in_chat
      ON desk_tasks(home_session_id)
      WHERE runs_in = 'chat' AND status IN ('open', 'deferred') AND archived_at IS NULL`
