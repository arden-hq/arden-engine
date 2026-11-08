import { Schema } from "effect"
import {
  ConnectionActionSchema,
  ConnectionStateSchema,
  event,
  optionalBoolean,
  optionalNullableString,
  sessionEvent
} from "../../common/schema.js"
import { ApprovalPresentationSchema, type ApprovalPresentation } from "../approval-presentation.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { CommonServerEventFields } from "../../common/event-fields.js"
import type { ConnectionAction, ConnectionState } from "../runtime.js"
import type { JsonRecord } from "../../common/json.js"
import { RunApprovalWorkSchema, type RunApprovalWork } from "../../runs/context.js"
import { RuleSavedInSchema, type RuleSavedIn } from "../../runs/questions.js"

/** A few event-specific payloads intentionally carry a nullable session id. */
interface NullableSessionServerEventFields extends JsonRecord {
  readonly timestamp?: number
  readonly seq?: number
  readonly session_id?: string | null
  readonly replay?: boolean
}

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

export interface ApprovalNeededEvent extends NullableSessionServerEventFields {
  readonly type: "approval_needed"
  readonly tool_id: string
  readonly name: string
  readonly path?: string | null
  readonly diff?: string | null
  readonly content_preview?: string | null
  readonly run_id?: string | null
  readonly session_id?: string | null
  readonly action?: string | null
  readonly scope?: string | null
  readonly expires_at?: string | null
  /** Where the card's "Always allow" saves (`RuntimeApprovalSnapshot.rule_places`). */
  readonly rule_places?: ReadonlyArray<RuleSavedIn>
  readonly can_attach_folder_to_space?: boolean
  /** The folder those choices keep, written for the card. */
  readonly grant_folder?: string
  readonly presentation?: ApprovalPresentation
  readonly decision_route?: DecisionRoute
  /** The Task or Automation the asking run works for, on a card delivered to
   *  another chat; it names who asks there. */
  readonly work?: RunApprovalWork
}

export interface ApprovalResolvedEvent extends CommonServerEventFields {
  readonly type: "approval_resolved"
  readonly run_id: string
  readonly tool_id: string
  readonly approved: boolean
  readonly decision_route?: DecisionRoute
}

export interface ConnectionNeededEvent extends CommonServerEventFields {
  readonly type: "connection_needed"
  readonly run_id: string
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
  readonly account_ref?: string | null
  readonly decision_route?: DecisionRoute
}

export interface ConnectionResolvedEvent extends CommonServerEventFields {
  readonly type: "connection_resolved"
  readonly run_id: string
  readonly tool_id: string
  readonly connection_id: string
  readonly approved: boolean
  readonly decision_route?: DecisionRoute
}

/** Decisions the run waits on: tool approvals and connection requests, asked and resolved. */
export type ApprovalEvent =
  | ApprovalNeededEvent
  | ApprovalResolvedEvent
  | ConnectionNeededEvent
  | ConnectionResolvedEvent

export const ApprovalNeededEventSchema = sessionEvent("approval_needed", optionalNullableString, {
  tool_id: Schema.String,
  name: Schema.String,
  path: optionalNullableString,
  diff: optionalNullableString,
  content_preview: optionalNullableString,
  run_id: optionalNullableString,
  action: optionalNullableString,
  scope: optionalNullableString,
  expires_at: optionalNullableString,
  rule_places: Schema.optionalKey(Schema.Array(RuleSavedInSchema)),
  can_attach_folder_to_space: optionalBoolean,
  grant_folder: Schema.optionalKey(Schema.String),
  presentation: Schema.optionalKey(ApprovalPresentationSchema),
  decision_route: Schema.optionalKey(DecisionRouteSchema),
  work: Schema.optionalKey(RunApprovalWorkSchema)
})

export const ApprovalResolvedEventSchema = event("approval_resolved", {
  run_id: Schema.String,
  tool_id: Schema.String,
  approved: Schema.Boolean,
  decision_route: Schema.optionalKey(DecisionRouteSchema)
})

export const ConnectionNeededEventSchema = event("connection_needed", {
  run_id: Schema.String,
  session_id: optionalNullableString,
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
  account_ref: optionalNullableString,
  decision_route: Schema.optionalKey(DecisionRouteSchema)
})

export const ConnectionResolvedEventSchema = event("connection_resolved", {
  run_id: Schema.String,
  tool_id: Schema.String,
  connection_id: Schema.String,
  approved: Schema.Boolean,
  decision_route: Schema.optionalKey(DecisionRouteSchema)
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
