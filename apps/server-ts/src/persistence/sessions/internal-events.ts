import type { AutomationEvent } from "@arden-hq/protocol"
import { Schema } from "effect"

const cause = {
  produced_by: Schema.NullOr(Schema.NonEmptyString),
  chain_depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}

export const RunSettledEventSchema = Schema.Struct({
  type: Schema.Literal("run_settled"),
  run_id: Schema.NonEmptyString,
  session_id: Schema.NonEmptyString,
  status: Schema.Literals(["completed", "interrupted", "error", "failed", "cancelled"] as const),
  final_message_id: Schema.NonEmptyString,
  personal: Schema.Boolean,
  ...cause
})
type RunSettledEvent = typeof RunSettledEventSchema.Type

export const LimitCrossedEventSchema = Schema.Struct({
  type: Schema.Literal("limit_crossed"),
  level: Schema.Literals(["background", "arden", "used_up"] as const),
  used_percent: Schema.Number,
  limit_percent: Schema.NullOr(Schema.Number),
  window_seconds: Schema.Number,
  resets_at: Schema.String,
  ...cause
})
type LimitCrossedEvent = typeof LimitCrossedEventSchema.Type

export const ApprovalWaitingEventSchema = Schema.Struct({
  type: Schema.Literal("approval_waiting"),
  run_id: Schema.NonEmptyString,
  session_id: Schema.NonEmptyString,
  tool_call_id: Schema.NonEmptyString,
  tool_name: Schema.NonEmptyString,
  ...cause
})
type ApprovalWaitingEvent = typeof ApprovalWaitingEventSchema.Type

export const DecisionRouteChangedEventSchema = Schema.Struct({
  type: Schema.Literal("decision_route_changed"),
  transition: Schema.Literals(["opened", "closed"] as const),
  viewer_session_id: Schema.NonEmptyString,
  source_session_id: Schema.NonEmptyString,
  source_kind: Schema.Literals(["run", "deferred"] as const),
  run_id: Schema.NonEmptyString,
  tool_call_id: Schema.NonEmptyString,
  basis: Schema.Literals([
    "source_v1",
    "agent_delegation_v1",
    "side_outcome_recovery_v1",
    "automation_creator_v1",
    "destination_v1"
  ] as const),
  ...cause
})
type DecisionRouteChangedEvent = typeof DecisionRouteChangedEventSchema.Type

export const CaptureArrivedEventSchema = Schema.Struct({
  type: Schema.Literal("capture_arrived"),
  session_id: Schema.NonEmptyString,
  client_id: Schema.NonEmptyString,
  via: Schema.Literals(["screenshot", "quick", "phone"] as const),
  note: Schema.String,
  screenshot: Schema.Boolean,
  ...cause
})
export type CaptureArrivedEvent = typeof CaptureArrivedEventSchema.Type

export const AutomationQueuedEventSchema = Schema.Struct({
  type: Schema.Literal("automation_queued"),
  event_type: Schema.NonEmptyString,
  event_key: Schema.NonEmptyString,
  queued: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ...cause
})
type AutomationQueuedEvent = typeof AutomationQueuedEventSchema.Type

export const AutomationChangedEventSchema = Schema.Struct({
  type: Schema.Literal("automation_changed"),
  task_id: Schema.NonEmptyString,
  ...cause
})
type AutomationChangedEvent = typeof AutomationChangedEventSchema.Type

export const TaskHistoryAddedEventSchema = Schema.Struct({
  type: Schema.Literal("task_history_added"),
  item_id: Schema.NonEmptyString,
  event_id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ...cause
})
type TaskHistoryAddedEvent = typeof TaskHistoryAddedEventSchema.Type

export const RunFencedEventSchema = Schema.Struct({
  type: Schema.Literal("run_fenced"),
  run_id: Schema.NonEmptyString,
  session_id: Schema.NonEmptyString,
  ...cause
})
type RunFencedEvent = typeof RunFencedEventSchema.Type

export type InternalLifecycleEvent =
  | RunSettledEvent
  | RunFencedEvent
  | LimitCrossedEvent
  | ApprovalWaitingEvent
  | DecisionRouteChangedEvent
  | CaptureArrivedEvent
  | AutomationQueuedEvent
  | AutomationChangedEvent
  | TaskHistoryAddedEvent

export const InternalLifecycleEventSchema: Schema.Codec<InternalLifecycleEvent> = Schema.Union([
  RunSettledEventSchema,
  RunFencedEventSchema,
  LimitCrossedEventSchema,
  ApprovalWaitingEventSchema,
  DecisionRouteChangedEventSchema,
  CaptureArrivedEventSchema,
  AutomationQueuedEventSchema,
  AutomationChangedEventSchema,
  TaskHistoryAddedEventSchema
])

const internalTypes: Readonly<Record<InternalLifecycleEvent["type"], true>> = {
  run_settled: true,
  run_fenced: true,
  limit_crossed: true,
  approval_waiting: true,
  decision_route_changed: true,
  capture_arrived: true,
  automation_queued: true,
  automation_changed: true,
  task_history_added: true
}

export const isInternalLifecycleEvent = (
  event: AutomationEvent | InternalLifecycleEvent
): event is InternalLifecycleEvent => Object.hasOwn(internalTypes, event.type)
