import { Schema } from "effect"
import { RunApprovalWorkSchema } from "../runs/context.js"
import { RuleSavedInSchema } from "../runs/questions.js"
import { ConnectionActionSchema, ConnectionStateSchema, withExtras } from "../common/schema.js"
import { ApprovalPresentationSchema } from "./approval-presentation.js"
import { ConnectionAccountSchema } from "./events/approval.js"
import {
  APPROVAL_ASKER,
  APPROVAL_CARD,
  APPROVAL_DIFF,
  APPROVAL_GRANT_FOLDER,
  APPROVAL_PREVIEW
} from "./runtime.js"

export const ApprovalGrantFolderSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_GRANT_FOLDER.none) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_GRANT_FOLDER.folder), folder: Schema.String })
])

export const ApprovalAskerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_ASKER.chat) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_ASKER.work), work: RunApprovalWorkSchema })
])

const ApprovalPreviewSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_PREVIEW.none) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_PREVIEW.preview), text: Schema.String })
])

const ApprovalDiffSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_DIFF.none) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_DIFF.diff), patch: Schema.String })
])

export const ApprovalCardSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_CARD.plain) }),
  Schema.Struct({
    kind: Schema.Literal(APPROVAL_CARD.presented),
    presentation: ApprovalPresentationSchema
  })
])

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
