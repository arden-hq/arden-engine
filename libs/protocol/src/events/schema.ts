import { Schema } from "effect"
import type { Agrees, Assert } from "../common/type-agreement.js"
import { eventTypeLiterals } from "../common/event-types.js"
import { ENTITY_TARGET, LINK, TASK_SPACE } from "../common/links.js"
import { SessionListItemSchema } from "../sessions/state-schema.js"
import type {
  AutomationEvent,
  RecordToldStatus,
  ServerEvent,
  TaskWorkChangedEvent
} from "./contracts.js"
import { NAVIGATION_ASKED_BY } from "../common/navigation.js"
import type { JsonRecord } from "../common/json.js"
import { AUTOMATION_RUN_OUTCOMES } from "../automations/outcome.js"

import { ChatServerEventSchema, StreamKeepaliveEventSchema } from "../chat/schema.js"
import {
  AppDestinationSchema,
  IsoDateTimeStringSchema,
  event,
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

const LinkedChatSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(LINK.none) }),
  Schema.Struct({ kind: Schema.Literal(LINK.chat), session_id: Schema.NonEmptyString })
])

const LinkedTaskSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(LINK.none) }),
  Schema.Struct({ kind: Schema.Literal(LINK.task), item_id: Schema.NonEmptyString })
])

const TaskSpaceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(TASK_SPACE.none) }),
  Schema.Struct({ kind: Schema.Literal(TASK_SPACE.space), space_id: Schema.NonEmptyString })
])

export const AutomationFinishedEventSchema = event("automation_finished", {
  task_id: Schema.String,
  outcome: Schema.Literals([...AUTOMATION_RUN_OUTCOMES, "completed"] as const),
  run_chat: LinkedChatSchema
})

const RecordToldStatusSchema = Schema.Literals([
  "finished",
  "blocked",
  "failed",
  "cancelled",
  "silent",
  "waiting",
  "done",
  "paused",
  "posted"
] as const)

export const RecordToldEventSchema = event("record_told", {
  key: Schema.NonEmptyString,
  record: Schema.Literals(["ending", "entity"] as const),
  status: RecordToldStatusSchema,
  shown: Schema.Boolean,
  unread: Schema.Boolean,
  title: Schema.String,
  text: Schema.String,
  chat: LinkedChatSchema,
  automation: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(LINK.none) }),
    Schema.Struct({ kind: Schema.Literal(LINK.automation), automation_id: Schema.NonEmptyString })
  ]),
  task: LinkedTaskSchema
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
  mode: Schema.Literals(["offer", "open"] as const),
  asked_by: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(NAVIGATION_ASKED_BY.untracked) }),
    Schema.Struct({
      kind: Schema.Literal(NAVIGATION_ASKED_BY.tool_call),
      tool_call_id: Schema.NonEmptyString
    })
  ])
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
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(ENTITY_TARGET.many) }),
    Schema.Struct({ kind: Schema.Literal(ENTITY_TARGET.one), id: Schema.NonEmptyString })
  ])
})

/** One Task moved: a comment landed, or its status changed. */
export const QuestionChangedEventSchema = sessionEvent("question_changed", Schema.NonEmptyString, {
  question_id: Schema.NonEmptyString,
  run_id: Schema.NonEmptyString,
  task: LinkedTaskSchema
})

export const TaskVisibilityChangedEventSchema = event("task_visibility_changed", {
  space: TaskSpaceSchema,
  item_id: Schema.NonEmptyString
})

export const WorkChangedEventSchema = event("work_changed", {
  space: TaskSpaceSchema,
  item_id: Schema.NonEmptyString,
  change: Schema.Literals(["comment", "status"] as const)
})

export const TaskProposalChangedEventSchema = event("task_proposal_changed", {
  space_id: Schema.NonEmptyString,
  proposal_id: Schema.NonEmptyString,
  revision: NonNegativeIntSchema,
  status: Schema.Literals(["offered", "accepted", "rejected", "expired", "retired"] as const)
})

export const FocusChoiceChangedEventSchema = event("focus_choice_changed", {
  space_id: Schema.NonEmptyString,
  question_id: Schema.NonEmptyString,
  revision: NonNegativeIntSchema,
  status: Schema.Literals(["offered", "settled"] as const)
})

const taskWorkEventFields = {
  space: TaskSpaceSchema,
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
