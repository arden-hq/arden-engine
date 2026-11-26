import { DateTime, Option, Schema } from "effect"
import {
  AUTOMATION_DESTINATION,
  MEMORY_DESTINATION,
  SESSION_DESTINATION_TURN,
  SETTINGS_DESTINATION_TAB,
  type AppSettingsTabId
} from "./navigation.js"
import type { Agrees, Assert } from "./type-agreement.js"
import type { ConnectionState, RuntimeRunStatus } from "../chat/runtime.js"
import { TODO_REASON, TODO_STATUS } from "../sessions/todos/contracts.js"

/** Shared schema helpers. All public object schemas retain additive fields. */
export const extraFields = [Schema.Record(Schema.String, Schema.Unknown)] as const
export const unknownRecord = Schema.Record(Schema.String, Schema.Unknown)

/**
 * ISO-8601 date-time text with an explicit UTC (`Z`) or numeric-offset zone.
 * Bracketed named zones (`[Europe/Paris]`) are deliberately rejected: no wire
 * producer emits them and downstream `Date` parsing cannot read them.
 */
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

export const optionalString = Schema.optionalKey(Schema.String)
export const optionalNullableString = Schema.optionalKey(Schema.NullOr(Schema.String))
export const optionalNumber = Schema.optionalKey(Schema.Number)
export const optionalInt = Schema.optionalKey(Schema.Int)
export const optionalNonNegativeInt = Schema.optionalKey(NonNegativeIntSchema)
export const optionalBoolean = Schema.optionalKey(Schema.Boolean)
export const optionalUnknown = Schema.optionalKey(Schema.Unknown)

type WithExtras<Fields extends Schema.Struct.Fields> = Schema.StructWithRest<
  Schema.Struct<Fields>,
  readonly [Schema.$Record<Schema.String, Schema.Unknown>]
>

export const withExtras = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): WithExtras<Fields> => Schema.StructWithRest(Schema.Struct(fields), extraFields)

const eventCommon = <const Type extends string>(type: Type) => ({
  type: Schema.Literal(type),
  timestamp: optionalNumber,
  seq: optionalNonNegativeInt,
  replay: optionalBoolean
})

type EventFields<Type extends string> = ReturnType<typeof eventCommon<Type>>

export const event = <const Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields
): WithExtras<EventFields<Type> & { session_id: typeof optionalString } & Fields> =>
  withExtras({
    ...eventCommon(type),
    session_id: optionalString,
    ...fields
  })

/** Event variant for a required or nullable session identifier. */
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
    ...eventCommon(type),
    session_id: sessionId,
    ...fields
  })

export const eventUsage = withExtras({
  prompt: optionalNumber,
  completion: optionalNumber,
  total: optionalNumber,
  cache_read: optionalNumber,
  cache_write: optionalNumber,
  cost: optionalNumber,
  exclusive_cost: optionalNumber
})

const toolOutcomeError = withExtras({
  code: Schema.String,
  retryable: Schema.Boolean,
  recovery_action: optionalString,
  diagnostic_ref: optionalString
})

const toolOutcomeEffect = withExtras({
  operation: Schema.String,
  target: Schema.String,
  before_ref: optionalString,
  after_ref: optionalString
})

const toolOutcomeVerification = withExtras({
  postcondition: Schema.String,
  observed: Schema.String,
  confidence: optionalNumber
})

const toolOutcomeStatus = Schema.Literals(["succeeded", "failed", "denied", "uncertain"] as const)

export const ToolOutcomeSchema = withExtras({
  status: toolOutcomeStatus,
  error: Schema.optionalKey(toolOutcomeError),
  effect: Schema.optionalKey(toolOutcomeEffect),
  verification: Schema.optionalKey(toolOutcomeVerification),
  receipt: optionalString
})

export const RuntimeRunStatusSchema = Schema.Literals([
  "pending",
  "running",
  "interrupted",
  "error",
  "cancelled",
  "completed"
] as const)
export const SessionTypeSchema = Schema.Literals(["chat", "channel", "agent"] as const)
export const ConnectionStateSchema = Schema.Literals([
  "not_configured",
  "disabled",
  "auth_required",
  "scope_required",
  "degraded"
] as const)
export const ConnectionActionSchema = Schema.Literals([
  "oauth",
  "credentials",
  "enable",
  "settings"
] as const)

export const AppSettingsTabIdSchema = Schema.Literals([
  "integrations",
  "models",
  "usage",
  "tools",
  "skills",
  "permissions",
  "appearance",
  "storage",
  "archive",
  "iphone"
] as const)

/** @internal Compile-time check that the schema and the type agree. */
export type AppSettingsTabIdAgrees = Assert<
  Agrees<typeof AppSettingsTabIdSchema.Type, AppSettingsTabId>
>

export const AppDestinationSchema = Schema.Union([
  withExtras({ kind: Schema.Literal("home") }),
  withExtras({
    kind: Schema.Literal("session"),
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
    kind: Schema.Literal("settings"),
    tab: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(SETTINGS_DESTINATION_TAB.general) }),
      Schema.Struct({
        kind: Schema.Literal(SETTINGS_DESTINATION_TAB.tab),
        tab_id: AppSettingsTabIdSchema
      })
    ])
  }),
  withExtras({
    kind: Schema.Literal("automation"),
    target: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(AUTOMATION_DESTINATION.list) }),
      Schema.Struct({
        kind: Schema.Literal(AUTOMATION_DESTINATION.automation),
        task_id: Schema.NonEmptyString
      })
    ])
  }),
  withExtras({ kind: Schema.Literal("task"), item_id: Schema.NonEmptyString }),
  withExtras({
    kind: Schema.Literal("memory"),
    target: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(MEMORY_DESTINATION.index) }),
      Schema.Struct({ kind: Schema.Literal(MEMORY_DESTINATION.page), path: Schema.NonEmptyString })
    ])
  }),
  withExtras({ kind: Schema.Literal("space"), space_id: Schema.NonEmptyString })
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

/** @internal Compile-time check that the schema and the type agree. */
export type RuntimeRunStatusAgrees = Assert<
  Agrees<(typeof RuntimeRunStatusSchema)["Type"], RuntimeRunStatus>
>

/** @internal Compile-time check that the schema and the type agree. */
export type ConnectionStateAgrees = Assert<
  Agrees<(typeof ConnectionStateSchema)["Type"], ConnectionState>
>
