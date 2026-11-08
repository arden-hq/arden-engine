import type { Migration } from "./index.js"

export const modelCallTimes: Migration = {
  version: 26,
  name: "model_call_times",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("ALTER TABLE run_model_usage ADD COLUMN admitted_at TEXT")
    database.exec("ALTER TABLE run_model_usage ADD COLUMN responded_at TEXT")
  }
}
