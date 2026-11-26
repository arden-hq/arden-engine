import { Schema } from "effect"
import { IsoDateTimeStringSchema } from "../common/schema.js"
import {
  ApprovalAskerSchema,
  ApprovalCardSchema,
  ApprovalDiffSchema,
  ApprovalGrantFolderSchema,
  ApprovalPreviewSchema
} from "../chat/approval-fields-schema.js"
import { RuntimeConnectionSnapshotSchema } from "../chat/schema.js"
import { APPROVAL_CONNECTION, APPROVAL_TEXT, type RunApproval } from "./approvals.js"
import { RuleSavedInSchema } from "./questions.js"

const ApprovalTextSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_TEXT.none) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_TEXT.text), text: Schema.String })
])

const INTEGRATION_CONNECTION = "integration_connection"

export const runApprovalFields = {
  at: IsoDateTimeStringSchema,
  run_id: Schema.String,
  session_id: Schema.String,
  destination_session_id: Schema.String,
  asker: ApprovalAskerSchema,
  tool_call_id: Schema.String,
  decision_delivery: Schema.Literals(["blocking", "deferred"] as const),
  kind: Schema.String,
  connection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(APPROVAL_CONNECTION.none) }),
    Schema.Struct({
      kind: Schema.Literal(APPROVAL_CONNECTION.connection),
      connection: RuntimeConnectionSnapshotSchema
    })
  ]),
  tool_name: Schema.String,
  action: Schema.String,
  preview: ApprovalPreviewSchema,
  description: ApprovalTextSchema,
  detail: ApprovalTextSchema,
  subject: ApprovalTextSchema,
  card: ApprovalCardSchema,
  diff: ApprovalDiffSchema,
  rule_places: Schema.Array(RuleSavedInSchema),
  can_attach_folder_to_space: Schema.Boolean,
  grant_folder: ApprovalGrantFolderSchema
} as const

export const checkRunApprovalConnection = (
  approval: Pick<RunApproval, "kind" | "connection" | "run_id" | "tool_call_id">
): string | undefined => {
  const connection = approval.connection
  if (approval.kind !== INTEGRATION_CONNECTION)
    return connection.kind === APPROVAL_CONNECTION.none
      ? undefined
      : "Only a connection decision may carry connection details"
  if (connection.kind === APPROVAL_CONNECTION.none) return "Connection details are required"
  return connection.connection.run_id === approval.run_id &&
    connection.connection.tool_id === approval.tool_call_id
    ? undefined
    : "Connection address must match its approval"
}
