import { SERVER_EVENT_TYPE } from "../../common/event-types.js"
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
import type { JsonRecord } from "../../common/json.js"
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
import { RuleSavedInSchema, type RuleSavedIn } from "../../runs/questions.js"

export const DECISION_ROUTE_SOURCE = { run: "run", deferred: "deferred" } as const

export type DecisionRouteSource = (typeof DECISION_ROUTE_SOURCE)[keyof typeof DECISION_ROUTE_SOURCE]

export interface DecisionRoute extends JsonRecord {
  readonly source_kind: DecisionRouteSource
  readonly source_session_id: string
  readonly basis:
    | "source_v1"
    | "agent_delegation_v1"
    | "side_outcome_recovery_v1"
    | "automation_creator_v1"
    | "destination_v1"
}

const DecisionRouteSchema = Schema.Struct({
  source_kind: Schema.Literals(Object.values(DECISION_ROUTE_SOURCE)),
  source_session_id: Schema.String,
  basis: Schema.Literals([
    "source_v1",
    "agent_delegation_v1",
    "side_outcome_recovery_v1",
    "automation_creator_v1",
    "destination_v1"
  ] as const)
})

export interface ApprovalNeededEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.approvalNeeded
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

export interface ApprovalResolvedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.approvalResolved
  readonly run_id: string
  readonly tool_id: string
  readonly approved: boolean
  readonly decision_route: DecisionRoute
}

export interface ConnectionNeededEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.connectionNeeded
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

export interface ConnectionResolvedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.connectionResolved
  readonly run_id: string
  readonly tool_id: string
  readonly connection_id: string
  readonly approved: boolean
  readonly decision_route: DecisionRoute
}

export type ApprovalEvent =
  | ApprovalNeededEvent
  | ApprovalResolvedEvent
  | ConnectionNeededEvent
  | ConnectionResolvedEvent

export const ApprovalNeededEventSchema = sessionEvent(
  SERVER_EVENT_TYPE.approvalNeeded,
  Schema.String,
  {
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
  }
)

export const ApprovalResolvedEventSchema = event(SERVER_EVENT_TYPE.approvalResolved, {
  run_id: Schema.String,
  tool_id: Schema.String,
  approved: Schema.Boolean,
  decision_route: DecisionRouteSchema
})

export const ConnectionNeededEventSchema = sessionEvent(
  SERVER_EVENT_TYPE.connectionNeeded,
  Schema.String,
  {
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
  }
)

export const ConnectionResolvedEventSchema = event(SERVER_EVENT_TYPE.connectionResolved, {
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

export type ApprovalEventAgrees = Assert<
  Agrees<(typeof approvalEventSchemas)[number]["Type"], ApprovalEvent>
>
