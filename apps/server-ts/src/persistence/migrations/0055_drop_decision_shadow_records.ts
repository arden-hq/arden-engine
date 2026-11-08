import type { Migration } from "./index.js"

export const dropDecisionShadowRecords: Migration = {
  version: 55,
  name: "drop_decision_shadow_records",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("DROP INDEX IF EXISTS idx_decision_shadow_records_site_model")
    database.exec("DROP TABLE IF EXISTS decision_shadow_records")
  }
}
