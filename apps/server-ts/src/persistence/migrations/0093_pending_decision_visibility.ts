import type { Migration } from "./index.js"
import { decisionVisibilityStatementsV1 } from "../schema/decision-visibility-released.js"

export const pendingDecisionVisibility: Migration = {
  version: 93,
  name: "pending_decision_visibility",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const statement of decisionVisibilityStatementsV1) database.exec(statement)
  }
}
