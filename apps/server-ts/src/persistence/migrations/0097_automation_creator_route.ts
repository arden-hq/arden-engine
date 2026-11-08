import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"
import { decisionCreatorRouteRebuild } from "../schema/decision-visibility-released.js"

const RECIPIENT_TRIGGERS = [
  "pending_decision_visibility_run_insert",
  "pending_decision_visibility_run_update",
  "pending_decision_visibility_deferred_insert",
  "pending_decision_visibility_deferred_update"
] as const

const up = (database: DatabaseSync): void => {
  for (const trigger of RECIPIENT_TRIGGERS) database.exec(`DROP TRIGGER ${trigger}`)
  database.exec(
    "ALTER TABLE pending_decision_visibility RENAME TO pending_decision_visibility_prior"
  )
  database.exec(decisionCreatorRouteRebuild.table)
  database.exec(`INSERT INTO pending_decision_visibility (
      viewer_session_id, source_kind, run_id, tool_call_id, source_session_id, route_basis,
      approval_run_id, approval_tool_call_id, deferred_run_id, deferred_tool_call_id
    ) SELECT viewer_session_id, source_kind, run_id, tool_call_id, source_session_id, route_basis,
      approval_run_id, approval_tool_call_id, deferred_run_id, deferred_tool_call_id
    FROM pending_decision_visibility_prior`)
  database.exec("DROP TABLE pending_decision_visibility_prior")
  for (const statement of decisionCreatorRouteRebuild.indexes) database.exec(statement)
  for (const statement of decisionCreatorRouteRebuild.triggers) database.exec(statement)
}

export const automationCreatorRoute: Migration = {
  version: 97,
  name: "automation_creator_route",
  foreignKeys: { kind: "rebuilds", tables: ["pending_decision_visibility"] },
  up
}
