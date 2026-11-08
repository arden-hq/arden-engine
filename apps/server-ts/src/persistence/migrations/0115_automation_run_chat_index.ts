import type { Migration } from "./index.js"

export const automationRunChatIndex: Migration = {
  version: 115,
  name: "automation_run_chat_index",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "CREATE INDEX idx_automation_runs_chat_session ON automation_runs(chat_session_id)"
    )
  }
}
