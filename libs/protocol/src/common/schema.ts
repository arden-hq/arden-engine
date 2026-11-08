import { DateTime, Option, Schema, SchemaTransformation } from "effect"
import type { ApiErrorEnvelope } from "./errors.js"
import type { AppSettingsTabId } from "./navigation.js"
import type { Agrees, Assert } from "./type-agreement.js"
import type { ConnectionState, RuntimeRunStatus } from "../chat/runtime.js"
import type { SessionTriageDecision } from "../sessions/contracts.js"

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

export const withExtras = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), extraFields)

const eventCommon = <const Type extends string>(type: Type) => ({
  type: Schema.Literal(type),
  timestamp: optionalNumber,
  seq: optionalNonNegativeInt,
  replay: optionalBoolean
})

export const event = <const Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields
) =>
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
) =>
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
  "recipes",
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

const destinationHome = withExtras({ kind: Schema.Literal("home") })
const destinationSession = withExtras({
  kind: Schema.Literal("session"),
  session_id: Schema.NonEmptyString,
  /** Land at this turn rather than the latest. */
  turn_id: Schema.optionalKey(Schema.NonEmptyString)
})
const destinationSettings = withExtras({
  kind: Schema.Literal("settings"),
  tab: Schema.optionalKey(Schema.NullOr(AppSettingsTabIdSchema))
})
const destinationAutomation = withExtras({
  kind: Schema.Literal("automation"),
  task_id: optionalNullableString
})
const destinationTask = withExtras({
  kind: Schema.Literal("task"),
  item_id: Schema.NonEmptyString
})
const destinationMemory = withExtras({
  kind: Schema.Literal("memory"),
  path: optionalNullableString
})
const destinationSpace = withExtras({
  kind: Schema.Literal("space"),
  space_id: Schema.NonEmptyString
})

const currentDestination = Schema.Union([
  destinationHome,
  destinationSession,
  destinationSettings,
  destinationAutomation,
  destinationTask,
  destinationMemory,
  destinationSpace
])

const legacyWorkDestination = withExtras({
  kind: Schema.Literal("work"),
  item_id: optionalNullableString
}).pipe(
  Schema.decodeTo(
    Schema.Union([destinationTask, destinationHome]),
    SchemaTransformation.transform({
      decode: (work) =>
        work.item_id ? { kind: "task" as const, item_id: work.item_id } : { kind: "home" as const },
      encode: (destination) => ({
        kind: "work" as const,
        ...(destination.kind === "task" ? { item_id: destination.item_id } : {})
      })
    })
  )
)

/** `currentDestination` comes first, so encoding writes the current shape. */
export const AppDestinationSchema = Schema.Union([currentDestination, legacyWorkDestination])

export const SessionPresentationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("conversation"),
    role: Schema.Literals(["space", "topic"])
  }),
  Schema.Struct({
    kind: Schema.Literal("execution"),
    label: Schema.Literals([
      "Space review",
      "Task worker",
      "Agent",
      "Side chat",
      "Automation",
      "System"
    ]),
    title: Schema.NonEmptyString,
    owner: Schema.NullOr(
      Schema.Struct({
        kind: Schema.Literals(["space", "task", "automation", "session"]),
        id: Schema.NonEmptyString,
        name: Schema.NonEmptyString
      })
    )
  })
])

const SessionTriageTargetSchema = Schema.Struct({
  space_id: Schema.NonEmptyString,
  title: Schema.String
})

export const SessionTriageDecisionSchema: Schema.Codec<SessionTriageDecision> = Schema.Union([
  Schema.Struct({
    decision: Schema.Literal("move"),
    target: SessionTriageTargetSchema,
    new_title: Schema.Null,
    rationale: Schema.String
  }),
  Schema.Struct({
    decision: Schema.Literal("create"),
    target: Schema.Null,
    new_title: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    rationale: Schema.String
  }),
  Schema.Struct({
    decision: Schema.Literal("none"),
    target: Schema.Null,
    new_title: Schema.Null,
    rationale: Schema.String
  }),
  Schema.Struct({
    decision: Schema.Literal("moved"),
    target: SessionTriageTargetSchema,
    new_title: Schema.Null,
    rationale: Schema.String
  })
])

export const SessionForkOriginSchema = Schema.Struct({
  sourceSessionId: Schema.NonEmptyString,
  sourceSessionRef: Schema.NullOr(Schema.NonEmptyString),
  throughSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  sourceMessageId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: IsoDateTimeStringSchema
})

const SessionForkSchema = withExtras({
  at: IsoDateTimeStringSchema,
  turn_id: Schema.NonEmptyString
})

const SessionThreadSourceSchema = withExtras({
  session_id: Schema.NonEmptyString,
  session_ref: Schema.NullOr(Schema.NonEmptyString)
})

export const SessionListItemSchema = withExtras({
  current_activity: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        run_id: Schema.String,
        sequence: NonNegativeIntSchema,
        description: Schema.NullOr(Schema.String),
        purpose: Schema.NullOr(Schema.String),
        run_purpose: Schema.optionalKey(Schema.NullOr(Schema.String)),
        operations: Schema.optionalKey(
          Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.NullOr(Schema.String) }))
        ),
        active_tool_call_ids: Schema.optionalKey(Schema.Array(Schema.String))
      })
    )
  ),
  agent_workspace: optionalNullableString,
  latest_run_id: optionalNullableString,
  presentation: Schema.optionalKey(SessionPresentationSchema),
  session_id: Schema.String,
  public_ref: optionalNullableString,
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  last_accessed_at: Schema.optionalKey(Schema.NullOr(IsoDateTimeStringSchema)),
  has_unread: optionalBoolean,
  name: Schema.NullOr(Schema.String),
  message_count: NonNegativeIntSchema,
  space_id: optionalNullableString,
  chat_model: optionalNullableString,
  session_type: Schema.optionalKey(SessionTypeSchema),
  origin_automation_id: optionalNullableString,
  parent_session_id: optionalNullableString,
  parent_tool_call_id: optionalNullableString,
  parent_message_id: optionalNullableString,
  parent_run_id: optionalNullableString,
  active_run_id: optionalNullableString,
  active_turn_id: optionalNullableString,
  run_status: Schema.optionalKey(Schema.NullOr(RuntimeRunStatusSchema)),
  checkpoint_seq: optionalNonNegativeInt,
  latest_event_seq: optionalNonNegativeInt,
  is_active: optionalBoolean,
  pending_approvals_count: optionalNonNegativeInt,
  pending_connections_count: optionalNonNegativeInt,
  run_error_code: optionalNullableString,
  run_stop_reason: optionalNullableString,
  triage: Schema.optionalKey(Schema.NullOr(SessionTriageDecisionSchema)),
  fork: Schema.optionalKey(Schema.NullOr(SessionForkSchema)),
  fork_origin: Schema.optionalKey(Schema.NullOr(SessionForkOriginSchema)),
  thread_source: Schema.optionalKey(Schema.NullOr(SessionThreadSourceSchema)),
  summary: optionalNullableString,
  origin: Schema.optionalKey(Schema.NullOr(Schema.Literals(["capture", "onboarding"] as const)))
})

const focusEvidence = withExtras({
  text: Schema.String,
  created_at: IsoDateTimeStringSchema,
  kind: optionalString,
  blocked_reason: optionalString
})

export const SessionFocusSchema = withExtras({
  session_id: Schema.String,
  focus_id: Schema.String,
  objective: Schema.String,
  status: Schema.Literals(["active", "paused", "blocked", "budget_limited", "complete"] as const),
  evidence: Schema.Array(focusEvidence),
  blocked_reason: optionalNullableString,
  token_budget: Schema.optionalKey(Schema.NullOr(PositiveIntSchema)),
  tokens_used: NonNegativeIntSchema,
  time_used_seconds: NonNegativeIntSchema,
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema
})

/** `id` stays the same across list rewrites (the store matches by content);
 *  `reason` says why a cancelled item was dropped. Lists stored before either
 *  existed carry neither. */
export const TodoListItemSchema = withExtras({
  id: optionalString,
  content: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"] as const),
  reason: optionalString
})

const validationIssueSchema = withExtras({
  type: optionalString,
  loc: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  msg: optionalString,
  input: optionalUnknown,
  ctx: Schema.optionalKey(unknownRecord)
})

export const ApiErrorEnvelopeSchema: Schema.Codec<ApiErrorEnvelope> = withExtras({
  detail: Schema.optionalKey(
    Schema.Union([Schema.String, unknownRecord, Schema.Array(validationIssueSchema)])
  ),
  message: optionalString,
  code: optionalString,
  debug_id: optionalNullableString,
  status: optionalInt
})

/** @internal Compile-time check that the schema and the type agree. */
export type RuntimeRunStatusAgrees = Assert<
  Agrees<(typeof RuntimeRunStatusSchema)["Type"], RuntimeRunStatus>
>

/** @internal Compile-time check that the schema and the type agree. */
export type ConnectionStateAgrees = Assert<
  Agrees<(typeof ConnectionStateSchema)["Type"], ConnectionState>
>
