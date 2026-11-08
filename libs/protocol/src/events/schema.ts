import { Schema } from "effect"
import type { Agrees, Assert } from "../common/type-agreement.js"
import { eventTypeLiterals } from "../common/event-types.js"
import type {
  AutomationEvent,
  RecordToldStatus,
  ServerEvent,
  TaskWorkChangedEvent
} from "./contracts.js"
import type { JsonRecord } from "../common/json.js"
import { AUTOMATION_RUN_OUTCOMES } from "../automations/outcome.js"

import { ChatServerEventSchema, StreamKeepaliveEventSchema } from "../chat/schema.js"
import {
  AppDestinationSchema,
  IsoDateTimeStringSchema,
  SessionListItemSchema,
  event,
  optionalNullableString,
  sessionEvent,
  NonNegativeIntSchema
} from "../common/schema.js"
import { ACTIVE_RUN_STATUSES } from "../runs/status.js"

/** Cursor correction for a resumable follower. Only the session/automation
 *  journal replays from a client cursor, so only that stream can reset; the
 *  Chat detail stream attaches at its captured head and signals a lost range
 *  with `stream_overflow` instead. */
export const StreamResetEventSchema = event("stream_reset", {
  reason: Schema.Literals(["future_cursor", "replay_gap"] as const)
})

export const AutomationProgressEventSchema = event("automation_progress", {
  task_id: Schema.String,
  status: Schema.String
})

export const AutomationFinishedEventSchema = event("automation_finished", {
  task_id: Schema.String,
  purpose: Schema.optionalKey(
    Schema.Literals(["user_automation", "space_review", "task_execution", "system"] as const)
  ),
  result: optionalNullableString,
  outcome: Schema.optionalKey(Schema.Literals([...AUTOMATION_RUN_OUTCOMES, "completed"] as const)),
  error: optionalNullableString,
  run_id: optionalNullableString,
  run_session_id: optionalNullableString
})

const RecordToldStatusSchema = Schema.Literals([
  "finished",
  "blocked",
  "failed",
  "cancelled",
  "silent",
  "waiting",
  "done",
  "paused"
] as const)

export const RecordToldEventSchema = event("record_told", {
  key: Schema.NonEmptyString,
  record: Schema.Literals(["ending", "entity"] as const),
  status: RecordToldStatusSchema,
  shown: Schema.Boolean,
  unread: Schema.Boolean,
  title: Schema.String,
  text: Schema.String,
  chat_session_id: optionalNullableString,
  automation_id: optionalNullableString,
  item_id: optionalNullableString
})

export const SessionCreatedEventSchema = event("session_created", {
  session: SessionListItemSchema
})

export const SessionActivityEventSchema = event("session_activity", {
  session: SessionListItemSchema
})

export const ChatInputCommittedEventSchema = event("chat_input_committed", {
  chat_session_id: Schema.NonEmptyString,
  run_id: Schema.NonEmptyString
})

export const SessionBlockingWorkEventSchema = sessionEvent(
  "session_blocking_work",
  Schema.NonEmptyString,
  {
    blocking_work: Schema.Boolean
  }
)

export const NavigationRequestedEventSchema = event("navigation_requested", {
  origin_session_id: Schema.NonEmptyString,
  destination: AppDestinationSchema,
  label: Schema.NonEmptyString,
  mode: Schema.optionalKey(Schema.Literals(["offer", "open"] as const)),
  tool_call_id: Schema.optionalKey(Schema.NonEmptyString)
})

export const McpServerChangedEventSchema = event("mcp_server_changed", {
  server: Schema.NonEmptyString
})

export const EntityChangedEventSchema = event("entity_changed", {
  kind: Schema.Literals([
    "session",
    "space",
    "automation",
    "permission",
    "task",
    "proposal"
  ] as const),
  id: Schema.NullOr(Schema.NonEmptyString)
})

/** One Task moved: a comment landed, or its status changed. */
export const QuestionChangedEventSchema = sessionEvent("question_changed", Schema.NonEmptyString, {
  question_id: Schema.NonEmptyString,
  run_id: Schema.NonEmptyString,
  item_id: Schema.NullOr(Schema.NonEmptyString)
})

export const TaskVisibilityChangedEventSchema = event("task_visibility_changed", {
  space_id: Schema.NullOr(Schema.NonEmptyString),
  item_id: Schema.NonEmptyString
})

export const WorkChangedEventSchema = event("work_changed", {
  space_id: Schema.NullOr(Schema.NonEmptyString),
  item_id: Schema.NonEmptyString,
  change: Schema.Literals(["comment", "status"] as const)
})

export const TaskProposalChangedEventSchema = event("task_proposal_changed", {
  space_id: Schema.NonEmptyString,
  proposal_id: Schema.NonEmptyString,
  revision: NonNegativeIntSchema,
  status: Schema.Literals(["offered", "accepted", "rejected", "retired"] as const)
})

export const FocusChoiceChangedEventSchema = event("focus_choice_changed", {
  space_id: Schema.NonEmptyString,
  question_id: Schema.NonEmptyString,
  revision: NonNegativeIntSchema,
  status: Schema.Literals(["offered", "settled"] as const)
})

const taskWorkEventFields = {
  space_id: Schema.NullOr(Schema.NonEmptyString),
  item_id: Schema.NonEmptyString,
  task_name: Schema.NonEmptyString,
  run_session_id: Schema.NonEmptyString,
  chat_run_id: Schema.NonEmptyString,
  started_at: IsoDateTimeStringSchema
}

export const TaskWorkChangedEventSchema: Schema.Codec<TaskWorkChangedEvent> = Schema.Union([
  event("task_work_changed", {
    ...taskWorkEventFields,
    state: Schema.Literal("running"),
    phase: Schema.Literals(ACTIVE_RUN_STATUSES),
    ended_at: Schema.Null,
    outcome: Schema.Null
  }),
  event("task_work_changed", {
    ...taskWorkEventFields,
    state: Schema.Literal("ended"),
    phase: Schema.Literal("ended"),
    ended_at: IsoDateTimeStringSchema,
    outcome: Schema.Literals(["finished", "failed", "stopped"] as const)
  })
])

const automationEventSchemas = [
  AutomationProgressEventSchema,
  AutomationFinishedEventSchema,
  RecordToldEventSchema,
  SessionCreatedEventSchema,
  SessionActivityEventSchema,
  ChatInputCommittedEventSchema,
  SessionBlockingWorkEventSchema,
  NavigationRequestedEventSchema,
  McpServerChangedEventSchema,
  EntityChangedEventSchema,
  WorkChangedEventSchema,
  TaskProposalChangedEventSchema,
  FocusChoiceChangedEventSchema,
  TaskWorkChangedEventSchema,
  TaskVisibilityChangedEventSchema,
  QuestionChangedEventSchema,
  StreamKeepaliveEventSchema,
  StreamResetEventSchema
] as const

export const AutomationEventSchema: Schema.Codec<AutomationEvent, JsonRecord> =
  Schema.Union(automationEventSchemas)

/** @internal Compile-time check that the schema and the type agree. */
export type AutomationEventAgrees = Assert<
  Agrees<(typeof automationEventSchemas)[number]["Type"], AutomationEvent>
>

const serverEventSchemas = [
  ChatServerEventSchema,
  AutomationProgressEventSchema,
  AutomationFinishedEventSchema,
  RecordToldEventSchema,
  SessionCreatedEventSchema,
  SessionActivityEventSchema,
  ChatInputCommittedEventSchema,
  SessionBlockingWorkEventSchema,
  NavigationRequestedEventSchema,
  McpServerChangedEventSchema,
  EntityChangedEventSchema,
  WorkChangedEventSchema,
  TaskProposalChangedEventSchema,
  FocusChoiceChangedEventSchema,
  TaskWorkChangedEventSchema,
  TaskVisibilityChangedEventSchema,
  QuestionChangedEventSchema,
  StreamResetEventSchema
] as const

export const ServerEventSchema: Schema.Codec<ServerEvent, JsonRecord> =
  Schema.Union(serverEventSchemas)

/** Every `type` the transport can carry, read from the schemas. */
export const SERVER_EVENT_TYPES: ReadonlySet<string> = eventTypeLiterals(serverEventSchemas)

/** True when this build of the protocol knows the event type. */
export const isKnownServerEventType = (type: string): boolean => SERVER_EVENT_TYPES.has(type)

/** @internal Compile-time check that the schema and the type agree. */
export type ServerEventAgrees = Assert<
  Agrees<(typeof serverEventSchemas)[number]["Type"], ServerEvent>
>

/** @internal Compile-time check that the schema and the type agree. */
export type RecordToldStatusAgrees = Assert<
  Agrees<(typeof RecordToldStatusSchema)["Type"], RecordToldStatus>
>
