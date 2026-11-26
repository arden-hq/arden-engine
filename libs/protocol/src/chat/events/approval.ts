import { Schema } from "effect"
import {
  ConnectionActionSchema,
  ConnectionStateSchema,
  event,
  sessionEvent
} from "../../common/schema.js"
import {
  ApprovalAskedSchema,
  ApprovalAskerSchema,
  ApprovalCardSchema,
  ApprovalDiffSchema,
  ApprovalGrantFolderSchema,
  ApprovalPreviewSchema,
  ConnectionAccountSchema
} from "../approval-fields-schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { CommonServerEventFields } from "../../common/event-fields.js"
import type {
  ApprovalAsked,
  ApprovalAsker,
  ApprovalCard,
  ApprovalDiff,
  ApprovalGrantFolder,
  ApprovalPreview,
  ConnectionAccount,
  ConnectionAction,
  ConnectionState
} from "../runtime.js"
import type { JsonRecord } from "../../common/json.js"
import { RuleSavedInSchema, type RuleSavedIn } from "../../runs/questions.js"

/** Persisted with each delivery so historical routing survives later moves. */
export interface DecisionRoute extends JsonRecord {
  readonly source_kind: "run" | "deferred"
  readonly source_session_id: string
  readonly basis:
    | "source_v1"
    | "agent_delegation_v1"
    | "side_outcome_recovery_v1"
    | "automation_creator_v1"
    | "destination_v1"
}

const DecisionRouteSchema = Schema.Struct({
  source_kind: Schema.Literals(["run", "deferred"] as const),
  source_session_id: Schema.String,
  basis: Schema.Literals([
    "source_v1",
    "agent_delegation_v1",
    "side_outcome_recovery_v1",
    "automation_creator_v1",
    "destination_v1"
  ] as const)
})

export interface ApprovalNeededEvent extends CommonServerEventFields {
  readonly type: "approval_needed"
  readonly tool_id: string
  readonly asked: ApprovalAsked
  readonly name: string
  readonly preview: ApprovalPreview
  readonly diff: ApprovalDiff
  readonly run_id: string
  readonly session_id: string
  readonly action: string
  readonly rule_places: ReadonlyArray<RuleSavedIn>
  readonly can_attach_folder_to_space: boolean
  readonly grant_folder: ApprovalGrantFolder
  readonly card: ApprovalCard
  readonly decision_route: DecisionRoute
  readonly asker: ApprovalAsker
}

export interface ApprovalResolvedEvent extends CommonServerEventFields {
  readonly type: "approval_resolved"
  readonly run_id: string
  readonly tool_id: string
  readonly approved: boolean
  readonly decision_route: DecisionRoute
}

export interface ConnectionNeededEvent extends CommonServerEventFields {
  readonly type: "connection_needed"
  readonly run_id: string
  readonly session_id: string
  readonly tool_id: string
  readonly integration_id: string
  readonly connection_id: string
  readonly label: string
  readonly reason: ConnectionState
  readonly detail: string
  readonly capability: string
  readonly action: ConnectionAction
  readonly settings_tab: string
  readonly required_scopes: ReadonlyArray<string>
  readonly source: "recovery" | "suggestion"
  readonly account: ConnectionAccount
  readonly decision_route: DecisionRoute
}

export interface ConnectionResolvedEvent extends CommonServerEventFields {
  readonly type: "connection_resolved"
  readonly run_id: string
  readonly tool_id: string
  readonly connection_id: string
  readonly approved: boolean
  readonly decision_route: DecisionRoute
}

/** Decisions the run waits on: tool approvals and connection requests, asked and resolved. */
export type ApprovalEvent =
  | ApprovalNeededEvent
  | ApprovalResolvedEvent
  | ConnectionNeededEvent
  | ConnectionResolvedEvent

export const ApprovalNeededEventSchema = sessionEvent("approval_needed", Schema.String, {
  tool_id: Schema.String,
  asked: ApprovalAskedSchema,
  name: Schema.String,
  preview: ApprovalPreviewSchema,
  diff: ApprovalDiffSchema,
  run_id: Schema.String,
  action: Schema.String,
  rule_places: Schema.Array(RuleSavedInSchema),
  can_attach_folder_to_space: Schema.Boolean,
  grant_folder: ApprovalGrantFolderSchema,
  card: ApprovalCardSchema,
  decision_route: DecisionRouteSchema,
  asker: ApprovalAskerSchema
})

export const ApprovalResolvedEventSchema = event("approval_resolved", {
  run_id: Schema.String,
  tool_id: Schema.String,
  approved: Schema.Boolean,
  decision_route: DecisionRouteSchema
})

export const ConnectionNeededEventSchema = sessionEvent("connection_needed", Schema.String, {
  run_id: Schema.String,
  tool_id: Schema.String,
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
  account: ConnectionAccountSchema,
  decision_route: DecisionRouteSchema
})

export const ConnectionResolvedEventSchema = event("connection_resolved", {
  run_id: Schema.String,
  tool_id: Schema.String,
  connection_id: Schema.String,
  approved: Schema.Boolean,
  decision_route: DecisionRouteSchema
})

export const approvalEventSchemas = [
  ApprovalNeededEventSchema,
  ApprovalResolvedEventSchema,
  ConnectionNeededEventSchema,
  ConnectionResolvedEventSchema
] as const

/** @internal Compile-time check that the schema and the type agree. */
export type ApprovalEventAgrees = Assert<
  Agrees<(typeof approvalEventSchemas)[number]["Type"], ApprovalEvent>
>
