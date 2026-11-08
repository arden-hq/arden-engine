import { Schema } from "effect"
import { IsoDateTimeStringSchema } from "../common/schema.js"
import { ApprovalPresentationSchema } from "../chat/approval-presentation.js"
import { RuntimeConnectionSnapshotSchema } from "../chat/schema.js"
import type { RunApproval } from "./approvals.js"
import { RunApprovalWorkSchema } from "./context.js"
import { RuleSavedInSchema } from "./questions.js"

export const runApprovalFields = {
  at: IsoDateTimeStringSchema,
  run_id: Schema.String,
  session_id: Schema.String,
  destination_session_id: Schema.String,
  work: Schema.NullOr(RunApprovalWorkSchema),
  tool_call_id: Schema.String,
  decision_delivery: Schema.optionalKey(Schema.Literals(["blocking", "deferred"] as const)),
  kind: Schema.String,
  connection: Schema.NullOr(RuntimeConnectionSnapshotSchema),
  tool_name: Schema.String,
  action: Schema.String,
  scope: Schema.String,
  preview: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  presentation: Schema.NullOr(ApprovalPresentationSchema),
  diff: Schema.NullOr(Schema.String),
  rule_places: Schema.Array(RuleSavedInSchema),
  can_attach_folder_to_space: Schema.optionalKey(Schema.Boolean),
  grant_folder: Schema.optionalKey(Schema.String)
} as const

export const checkRunApprovalConnection = (
  approval: Pick<RunApproval, "kind" | "connection" | "run_id" | "tool_call_id">
): string | undefined => {
  const connection = approval.connection
  if (approval.kind !== "integration_connection")
    return connection === null
      ? undefined
      : "Only a connection decision may carry connection details"
  if (connection === null) return "Connection details are required"
  return connection.run_id === approval.run_id && connection.tool_id === approval.tool_call_id
    ? undefined
    : "Connection address must match its approval"
}
