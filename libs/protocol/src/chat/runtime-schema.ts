import { Schema } from "effect"
import { RuleSavedInSchema } from "../runs/questions.js"
import { ConnectionActionSchema, ConnectionStateSchema, withExtras } from "../common/schema.js"
import {
  ApprovalAskerSchema,
  ApprovalCardSchema,
  ApprovalDiffSchema,
  ApprovalGrantFolderSchema,
  ApprovalPreviewSchema,
  ConnectionAccountSchema
} from "./approval-fields-schema.js"

export const RuntimeApprovalSnapshotSchema = withExtras({
  tool_id: Schema.String,
  source: Schema.Literals(["run", "deferred"] as const),
  tool_name: Schema.String,
  preview: ApprovalPreviewSchema,
  diff: ApprovalDiffSchema,
  status: Schema.Literal("pending"),
  requested_at: Schema.String,
  run_id: Schema.String,
  session_id: Schema.String,
  action: Schema.String,
  rule_places: Schema.Array(RuleSavedInSchema),
  can_attach_folder_to_space: Schema.Boolean,
  grant_folder: ApprovalGrantFolderSchema,
  card: ApprovalCardSchema,
  asker: ApprovalAskerSchema
})

export const RuntimeConnectionSnapshotSchema = withExtras({
  tool_id: Schema.String,
  run_id: Schema.String,
  session_id: Schema.String,
  integration_id: Schema.String,
  connection_id: Schema.String,
  label: Schema.String,
  reason: ConnectionStateSchema,
  detail: Schema.String,
  capability: Schema.String,
  action: ConnectionActionSchema,
  settings_tab: Schema.String,
  required_scopes: Schema.Array(Schema.String),
  source: Schema.Literals(["recovery", "suggestion"] as const),
  decision_delivery: Schema.Literals(["blocking", "deferred"] as const),
  account: ConnectionAccountSchema
})

export const ActiveRunSnapshotSchema = withExtras({
  run_id: Schema.String,
  turn_id: Schema.NonEmptyString,
  status: Schema.String,
  started_at: Schema.String,
  updated_at: Schema.String,
  checkpoint_seq: Schema.Int,
  latest_event_seq: Schema.Int,
  pending_approvals: Schema.Array(RuntimeApprovalSnapshotSchema),
  pending_connections: Schema.Array(RuntimeConnectionSnapshotSchema),
  waiting_tool_call_ids: Schema.Array(Schema.String)
})
export * from "./approval-fields-schema.js"
