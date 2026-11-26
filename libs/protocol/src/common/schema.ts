import { DateTime, Option, Schema } from "effect"
import {
  APP_DESTINATION,
  APP_SETTINGS_TAB,
  AUTOMATION_DESTINATION,
  MEMORY_DESTINATION,
  SESSION_DESTINATION_TURN,
  SETTINGS_DESTINATION_TAB,
  type AppSettingsTabId
} from "./navigation.js"
import { PROVIDER_COST } from "./event-fields.js"
import type { Agrees, Assert } from "./type-agreement.js"
import {
  CONNECTION_ACTION,
  CONNECTION_STATE,
  RUN_STATUS,
  type ConnectionState,
  type RuntimeRunStatus
} from "../chat/runtime.js"
import { TODO_REASON, TODO_STATUS } from "../sessions/todos/contracts.js"

export const extraFields = [Schema.Record(Schema.String, Schema.Unknown)] as const
export const unknownRecord = Schema.Record(Schema.String, Schema.Unknown)

export const IsoDateTimeStringSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.makeFilter((value) => {
    const hasExplicitZone =
      value.endsWith("Z") || Option.isSome(DateTime.makeZonedFromString(value))
    return value.includes("T") && hasExplicitZone && Option.isSome(DateTime.make(value))
      ? undefined
      : "must be an ISO-8601 date-time with an explicit zone"
  })
)

export const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

type WithExtras<Fields extends Schema.Struct.Fields> = Schema.StructWithRest<
  Schema.Struct<Fields>,
  readonly [Schema.$Record<Schema.String, Schema.Unknown>]
>

export const withExtras = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): WithExtras<Fields> => Schema.StructWithRest(Schema.Struct(fields), extraFields)

const eventType = <const Type extends string>(type: Type) => ({ type: Schema.Literal(type) })

type EventFields<Type extends string> = ReturnType<typeof eventType<Type>>

export const event = <const Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields
): WithExtras<EventFields<Type> & Fields> =>
  withExtras({
    ...eventType(type),
    ...fields
  })

export const sessionEvent = <
  const Type extends string,
  SessionId extends Schema.Top,
  Fields extends Schema.Struct.Fields
>(
  type: Type,
  sessionId: SessionId,
  fields: Fields
): WithExtras<EventFields<Type> & { session_id: SessionId } & Fields> =>
  withExtras({
    ...eventType(type),
    session_id: sessionId,
    ...fields
  })

const EventFrameSchema = Schema.Struct({
  seq: NonNegativeIntSchema,
  timestamp: Schema.Number,
  replay: Schema.Boolean
})

export const isEventFrame = Schema.is(EventFrameSchema)

export const isChatEventFrame = Schema.is(
  Schema.Struct({ ...EventFrameSchema.fields, session_id: Schema.NonEmptyString })
)

export const ProviderCostSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(PROVIDER_COST.unreported) }),
  Schema.Struct({
    kind: Schema.Literal(PROVIDER_COST.reported),
    usd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
  })
])

export const eventUsage = withExtras({
  prompt: Schema.Number,
  completion: Schema.Number,
  total: Schema.Number,
  cache_read: Schema.Number,
  cache_write: Schema.Number,
  cost: ProviderCostSchema
})

export const RuntimeRunStatusSchema = Schema.Literals(Object.values(RUN_STATUS))
export const SESSION_TYPE = { chat: "chat", channel: "channel", agent: "agent" } as const
export const SessionTypeSchema = Schema.Literals(Object.values(SESSION_TYPE))
export const ConnectionStateSchema = Schema.Literals(Object.values(CONNECTION_STATE))
export const ConnectionActionSchema = Schema.Literals(Object.values(CONNECTION_ACTION))

export const AppSettingsTabIdSchema = Schema.Literals(Object.values(APP_SETTINGS_TAB))

export type AppSettingsTabIdAgrees = Assert<
  Agrees<typeof AppSettingsTabIdSchema.Type, AppSettingsTabId>
>

export const AppDestinationSchema = Schema.Union([
  withExtras({ kind: Schema.Literal(APP_DESTINATION.home) }),
  withExtras({
    kind: Schema.Literal(APP_DESTINATION.session),
    session_id: Schema.NonEmptyString,
    turn: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(SESSION_DESTINATION_TURN.latest) }),
      Schema.Struct({
        kind: Schema.Literal(SESSION_DESTINATION_TURN.turn),
        turn_id: Schema.NonEmptyString
      })
    ])
  }),
  withExtras({
    kind: Schema.Literal(APP_DESTINATION.settings),
    tab: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(SETTINGS_DESTINATION_TAB.general) }),
      Schema.Struct({
        kind: Schema.Literal(SETTINGS_DESTINATION_TAB.tab),
        tab_id: AppSettingsTabIdSchema
      })
    ])
  }),
  withExtras({
    kind: Schema.Literal(APP_DESTINATION.automation),
    target: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(AUTOMATION_DESTINATION.list) }),
      Schema.Struct({
        kind: Schema.Literal(AUTOMATION_DESTINATION.automation),
        task_id: Schema.NonEmptyString
      })
    ])
  }),
  withExtras({ kind: Schema.Literal(APP_DESTINATION.task), item_id: Schema.NonEmptyString }),
  withExtras({
    kind: Schema.Literal(APP_DESTINATION.memory),
    target: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(MEMORY_DESTINATION.index) }),
      Schema.Struct({ kind: Schema.Literal(MEMORY_DESTINATION.page), path: Schema.NonEmptyString })
    ])
  }),
  withExtras({ kind: Schema.Literal(APP_DESTINATION.space), space_id: Schema.NonEmptyString })
])

const focusEvidence = withExtras({
  text: Schema.String,
  created_at: IsoDateTimeStringSchema
})

export const SessionFocusSchema = withExtras({
  session_id: Schema.String,
  focus_id: Schema.String,
  objective: Schema.String,
  status: Schema.Literals(["active", "paused", "blocked", "budget_limited", "complete"] as const),
  evidence: Schema.Array(focusEvidence),
  tokens_used: NonNegativeIntSchema,
  time_used_seconds: NonNegativeIntSchema,
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema
})

const TodoReasonSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(TODO_REASON.unstated) }),
  Schema.Struct({ kind: Schema.Literal(TODO_REASON.stated), text: Schema.String })
])

export const PlannedTodoStatusSchema = Schema.Literals([
  TODO_STATUS.pending,
  TODO_STATUS.in_progress,
  TODO_STATUS.completed
] as const)

export const TodoListItemSchema = Schema.Union([
  withExtras({ id: Schema.String, content: Schema.String, status: PlannedTodoStatusSchema }),
  withExtras({
    id: Schema.String,
    content: Schema.String,
    status: Schema.Literal(TODO_STATUS.cancelled),
    reason: TodoReasonSchema
  })
])

export type RuntimeRunStatusAgrees = Assert<
  Agrees<(typeof RuntimeRunStatusSchema)["Type"], RuntimeRunStatus>
>

export type ConnectionStateAgrees = Assert<
  Agrees<(typeof ConnectionStateSchema)["Type"], ConnectionState>
>
