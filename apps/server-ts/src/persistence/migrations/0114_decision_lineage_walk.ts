import type { Migration } from "./index.js"
import { decisionRecipientTriggers } from "../schema/decision-visibility.js"

const RECIPIENT_TRIGGERS = [
  "pending_decision_visibility_run_insert",
  "pending_decision_visibility_run_update",
  "pending_decision_visibility_deferred_insert",
  "pending_decision_visibility_deferred_update"
] as const

export const decisionLineageWalk: Migration = {
  version: 114,
  name: "decision_lineage_walk",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const trigger of RECIPIENT_TRIGGERS) database.exec(`DROP TRIGGER ${trigger}`)
    for (const statement of decisionRecipientTriggers) database.exec(statement)
  }
}
