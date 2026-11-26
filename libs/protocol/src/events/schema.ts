import { SERVER_EVENT_TYPE, eventTypeLiterals } from "../common/event-types.js"
import { Schema } from "effect"
import type { Agrees, Assert } from "../common/type-agreement.js"
import { ENTITY_TARGET, LINK, TASK_SPACE } from "../common/links.js"
import { SessionListItemSchema } from "../sessions/state-schema.js"
import type { EventFrame, Framed } from "../common/event-fields.js"
import {
  NAVIGATION_MODE,
  RECORD_TOLD_STATUS,
  TASK_WORK_STATE,
  type AutomationEvent,
  type LifecycleFeedBody,
  type RecordToldStatus,
  type ServerEvent,
  type TaskWorkChangedEvent
} from "./contracts.js"
import { NAVIGATION_ASKED_BY } from "../common/navigation.js"
import type { JsonRecord } from "../common/json.js"
import { AUTOMATION_RUN_OUTCOMES } from "../automations/outcome.js"

import { ChatServerEventSchema, StreamKeepaliveEventSchema } from "../chat/schema.js"
import {
  AppDestinationSchema,
  IsoDateTimeStringSchema,
  event,
  isEventFrame,
  sessionEvent,
  NonNegativeIntSchema
} from "../common/schema.js"
import { ACTIVE_RUN_STATUSES } from "../runs/status.js"

export const StreamResetEventSchema = event(SERVER_EVENT_TYPE.streamReset, {
  session_id: Schema.NonEmptyString,
  seq: NonNegativeIntSchema,
  reason: Schema.Literals(["future_cursor", "replay_gap"] as const)
})

export const AutomationProgressEventSchema = event(SERVER_EVENT_TYPE.automationProgress, {
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

export const AutomationFinishedEventSchema = event(SERVER_EVENT_TYPE.automationFinished, {
  task_id: Schema.String,
  outcome: Schema.Literals([...AUTOMATION_RUN_OUTCOMES, "completed"] as const),
  run_chat: LinkedChatSchema
})

const RecordToldStatusSchema = Schema.Literals(Object.values(RECORD_TOLD_STATUS))

export const RecordToldEventSchema = event(SERVER_EVENT_TYPE.recordTold, {
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

export const SessionCreatedEventSchema = event(SERVER_EVENT_TYPE.sessionCreated, {
  session: SessionListItemSchema
})

export const SessionActivityEventSchema = event(SERVER_EVENT_TYPE.sessionActivity, {
  session: SessionListItemSchema
})

export const ChatInputCommittedEventSchema = event(SERVER_EVENT_TYPE.chatInputCommitted, {
  chat_session_id: Schema.NonEmptyString,
  run_id: Schema.NonEmptyString
})

export const SessionBlockingWorkEventSchema = sessionEvent(
  SERVER_EVENT_TYPE.sessionBlockingWork,
  Schema.NonEmptyString,
  {
    blocking_work: Schema.Boolean
  }
)

export const NavigationRequestedEventSchema = event(SERVER_EVENT_TYPE.navigationRequested, {
  origin_session_id: Schema.NonEmptyString,
  destination: AppDestinationSchema,
  label: Schema.NonEmptyString,
  mode: Schema.Literals(Object.values(NAVIGATION_MODE)),
  asked_by: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(NAVIGATION_ASKED_BY.untracked) }),
    Schema.Struct({
      kind: Schema.Literal(NAVIGATION_ASKED_BY.tool_call),
      tool_call_id: Schema.NonEmptyString
    })
  ])
})

export const McpServerChangedEventSchema = event(SERVER_EVENT_TYPE.mcpServerChanged, {
  server: Schema.NonEmptyString
})

export const EntityChangedEventSchema = event(SERVER_EVENT_TYPE.entityChanged, {
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

export const QuestionChangedEventSchema = sessionEvent(
  SERVER_EVENT_TYPE.questionChanged,
  Schema.NonEmptyString,
  {
    question_id: Schema.NonEmptyString,
    run_id: Schema.NonEmptyString,
    task: LinkedTaskSchema
  }
)

export const TaskVisibilityChangedEventSchema = event(SERVER_EVENT_TYPE.taskVisibilityChanged, {
  space: TaskSpaceSchema,
  item_id: Schema.NonEmptyString
})

export const WorkChangedEventSchema = event(SERVER_EVENT_TYPE.workChanged, {
  space: TaskSpaceSchema,
  item_id: Schema.NonEmptyString,
  change: Schema.Literals(["comment", "status"] as const)
})

export const TaskProposalChangedEventSchema = event(SERVER_EVENT_TYPE.taskProposalChanged, {
  space_id: Schema.NonEmptyString,
  proposal_id: Schema.NonEmptyString,
  revision: NonNegativeIntSchema,
  status: Schema.Literals(["offered", "accepted", "rejected", "expired", "retired"] as const)
})

export const FocusChoiceChangedEventSchema = event(SERVER_EVENT_TYPE.focusChoiceChanged, {
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
  event(SERVER_EVENT_TYPE.taskWorkChanged, {
    ...taskWorkEventFields,
    state: Schema.Literal(TASK_WORK_STATE.running),
    phase: Schema.Literals(ACTIVE_RUN_STATUSES),
    ended_at: Schema.Null,
    outcome: Schema.Null
  }),
  event(SERVER_EVENT_TYPE.taskWorkChanged, {
    ...taskWorkEventFields,
    state: Schema.Literal(TASK_WORK_STATE.ended),
    phase: Schema.Literal(TASK_WORK_STATE.ended),
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

export type AutomationEventAgrees = Assert<
  Agrees<(typeof automationEventSchemas)[number]["Type"], AutomationEvent>
>

const lifecycleFeedSchemas = [
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
  QuestionChangedEventSchema
] as const

const LifecycleFeedBodySchema: Schema.Codec<LifecycleFeedBody, JsonRecord> =
  Schema.Union(lifecycleFeedSchemas)

const FramedLifecycleFeedEventSchema = LifecycleFeedBodySchema.pipe(
  Schema.refine((event): event is Framed<LifecycleFeedBody, EventFrame> => isEventFrame(event), {
    message: "lifecycle events must carry seq, timestamp and replay"
  })
)

const serverEventSchemas = [
  ChatServerEventSchema,
  FramedLifecycleFeedEventSchema,
  StreamResetEventSchema
] as const

export const ServerEventSchema: Schema.Codec<ServerEvent, JsonRecord> =
  Schema.Union(serverEventSchemas)

export const SERVER_EVENT_TYPES: ReadonlySet<string> = eventTypeLiterals(serverEventSchemas)

export const isKnownServerEventType = (type: string): boolean => SERVER_EVENT_TYPES.has(type)

export type ServerEventAgrees = Assert<
  Agrees<(typeof serverEventSchemas)[number]["Type"], ServerEvent>
>

export type RecordToldStatusAgrees = Assert<
  Agrees<(typeof RecordToldStatusSchema)["Type"], RecordToldStatus>
>
