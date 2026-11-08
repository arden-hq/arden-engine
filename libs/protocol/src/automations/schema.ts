import { Effect, Schema } from "effect"
import type { Agrees, Assert } from "../common/type-agreement.js"
import type {
  Automation,
  AutomationRunStatus,
  AutomationListResponse,
  AutomationEventCatalogResponse,
  AutomationRunsResponse,
  DeleteAutomationResponse,
  RunAutomationResponse,
  ToggleAutomationResponse,
  AutomationCondition,
  AutomationConditionInput,
  AutomationTrigger,
  AutomationTriggerInput
} from "./contracts.js"
import {
  IsoDateTimeStringSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"
import { AUTOMATION_EVENT_TYPES } from "./triggers.js"
import { APPROVAL_MODES } from "../permissions/modes.js"

const strict = { onExcessProperty: "error" } as const
const TrimmedTextSchema = Schema.Trim.check(Schema.isMinLength(1))
const DescriptionSchema = TrimmedTextSchema.check(Schema.isMaxLength(220))
const OptionalTextSchema = Schema.optionalKey(TrimmedTextSchema)
const NullableTextSchema = Schema.NullOr(Schema.String)
/** "Run only if": one plain sentence an event must match before a run starts. */
const RunOnlyIfSchema = TrimmedTextSchema.check(Schema.isMaxLength(300))
/** A stored trigger's id: "t" and a positive number. */
const TriggerIdSchema = Schema.String.check(Schema.isPattern(/^t[1-9]\d*$/u))
const triggerId = Schema.optionalKey(TriggerIdSchema)

export const AutomationConditionOperatorSchema = Schema.Literals([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "ends_with",
  "in",
  "exists"
] as const)

const comparisonFields = {
  kind: Schema.Literal("compare"),
  field: TrimmedTextSchema,
  op: AutomationConditionOperatorSchema,
  value: Schema.optionalKey(Schema.Json)
} as const

const comparisonCheck = Schema.makeFilter(
  (condition: { readonly op: string; readonly value?: unknown }) => {
    if (condition.op !== "exists" && !Object.hasOwn(condition, "value")) {
      return { path: ["value"], issue: "is required for this operator" }
    }
    if (condition.op === "in" && !Array.isArray(condition.value)) {
      return { path: ["value"], issue: "must be an array for the in operator" }
    }
    return undefined
  }
)

export const AutomationConditionInputSchema: Schema.Codec<AutomationConditionInput> =
  Schema.suspend((): Schema.Codec<AutomationConditionInput> =>
    Schema.Union([
      Schema.Struct(comparisonFields).check(comparisonCheck),
      Schema.Struct({
        kind: Schema.Literal("and"),
        conditions: Schema.NonEmptyArray(AutomationConditionInputSchema)
      }),
      Schema.Struct({
        kind: Schema.Literal("or"),
        conditions: Schema.NonEmptyArray(AutomationConditionInputSchema)
      }),
      Schema.Struct({
        kind: Schema.Literal("not"),
        condition: AutomationConditionInputSchema
      })
    ]).pipe(Schema.toTaggedUnion("kind"))
  )

export const AutomationConditionSchema: Schema.Codec<AutomationCondition> = Schema.suspend(
  (): Schema.Codec<AutomationCondition> =>
    Schema.Union([
      withExtras(comparisonFields).check(comparisonCheck),
      withExtras({
        kind: Schema.Literal("and"),
        conditions: Schema.NonEmptyArray(AutomationConditionSchema)
      }),
      withExtras({
        kind: Schema.Literal("or"),
        conditions: Schema.NonEmptyArray(AutomationConditionSchema)
      }),
      withExtras({
        kind: Schema.Literal("not"),
        condition: AutomationConditionSchema
      })
    ]).pipe(Schema.toTaggedUnion("kind"))
)

const timeTriggerFields = {
  id: triggerId,
  type: Schema.Literal("time"),
  at: OptionalTextSchema,
  on: OptionalTextSchema,
  days: OptionalTextSchema,
  every: OptionalTextSchema,
  start: OptionalTextSchema,
  end: OptionalTextSchema
} as const

const timeTriggerCheck = Schema.makeFilter(
  (trigger: {
    readonly at?: string
    readonly on?: string
    readonly days?: string
    readonly every?: string
    readonly start?: string
    readonly end?: string
  }) => {
    if ((trigger.at === undefined) === (trigger.every === undefined)) {
      return { path: [], issue: "requires exactly one of at or every" }
    }
    if (trigger.on !== undefined && trigger.at === undefined) {
      return { path: ["on"], issue: "requires at" }
    }
    if (trigger.on !== undefined && trigger.days !== undefined) {
      return { path: ["on"], issue: "cannot be combined with days" }
    }
    if ((trigger.start !== undefined || trigger.end !== undefined) && trigger.every === undefined) {
      return { path: [], issue: "start and end require an interval trigger" }
    }
    return undefined
  }
)

const AutomationEventTypeSchema = Schema.Literals(AUTOMATION_EVENT_TYPES)

const McpEventSelectorFields = {
  server: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  event: Schema.NonEmptyString.check(Schema.isMaxLength(256))
} as const
const McpEventArgumentsSchema = Schema.Record(Schema.String, Schema.Json)

const McpEventSelectorInputSchema = Schema.Struct({
  ...McpEventSelectorFields,
  arguments: Schema.optionalKey(McpEventArgumentsSchema)
})
const McpEventSelectorSchema = Schema.Struct({
  ...McpEventSelectorFields,
  arguments: McpEventArgumentsSchema
})

const eventTriggerInputFields = {
  id: triggerId,
  type: Schema.Literal("event"),
  event_type: AutomationEventTypeSchema,
  lead_minutes: Schema.optionalKey(Schema.NullOr(NonNegativeIntSchema)),
  mcp_event: Schema.optionalKey(Schema.NullOr(McpEventSelectorInputSchema)),
  condition: Schema.optionalKey(Schema.NullOr(AutomationConditionInputSchema)),
  run_only_if: Schema.optionalKey(Schema.NullOr(RunOnlyIfSchema))
} as const

const eventTriggerFields = {
  id: triggerId,
  type: Schema.Literal("event"),
  event_type: AutomationEventTypeSchema,
  lead_minutes: Schema.optionalKey(NonNegativeIntSchema),
  mcp_event: Schema.optionalKey(McpEventSelectorSchema),
  condition: Schema.optionalKey(Schema.NullOr(AutomationConditionSchema)),
  run_only_if: Schema.optionalKey(RunOnlyIfSchema)
} as const

const idleTriggerFields = {
  id: triggerId,
  type: Schema.Literal("idle"),
  idle_minutes: PositiveIntSchema
} as const

const countTriggerFields = {
  id: triggerId,
  type: Schema.Literal("count"),
  every_n: PositiveIntSchema
} as const

export const TimeAutomationTriggerInputSchema =
  Schema.Struct(timeTriggerFields).check(timeTriggerCheck)
export const EventAutomationTriggerInputSchema = Schema.Struct(eventTriggerInputFields)
export const IdleAutomationTriggerInputSchema = Schema.Struct(idleTriggerFields)
export const CountAutomationTriggerInputSchema = Schema.Struct(countTriggerFields)

export const AutomationTriggerInputSchema: Schema.Codec<AutomationTriggerInput> = Schema.Union([
  TimeAutomationTriggerInputSchema,
  EventAutomationTriggerInputSchema,
  IdleAutomationTriggerInputSchema,
  CountAutomationTriggerInputSchema
]).pipe(Schema.toTaggedUnion("type"))

export const TimeAutomationTriggerSchema = withExtras(timeTriggerFields).check(timeTriggerCheck)
export const EventAutomationTriggerSchema = withExtras(eventTriggerFields)
export const IdleAutomationTriggerSchema = withExtras(idleTriggerFields)
export const CountAutomationTriggerSchema = withExtras(countTriggerFields)

export const AutomationTriggerSchema: Schema.Codec<AutomationTrigger> = Schema.Union([
  TimeAutomationTriggerSchema,
  EventAutomationTriggerSchema,
  IdleAutomationTriggerSchema,
  CountAutomationTriggerSchema
]).pipe(Schema.toTaggedUnion("type"))

export const SettableAutomationToolScopeSchema = Schema.Literals([
  "read_only",
  "reports",
  "browser",
  "all"
] as const)

export const AutomationToolScopeSchema = Schema.Literals([
  "read_only",
  "reports",
  "browser",
  "all",
  "space",
  "memory_capture",
  "chat_summary"
] as const)

export const AutomationHistorySchema = Schema.Literals(["fresh", "chat"] as const)

export const AutomationChatChoiceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("own") }),
  Schema.Struct({ kind: Schema.Literal("yours"), session_id: Schema.NonEmptyString })
]).pipe(Schema.toTaggedUnion("kind"))

const createAutomationInputFields = {
  chat: Schema.optionalKey(AutomationChatChoiceSchema),
  name: TrimmedTextSchema,
  prompt: TrimmedTextSchema,
  description: Schema.optionalKey(DescriptionSchema),
  model: Schema.optionalKey(Schema.NullOr(TrimmedTextSchema)),
  history: AutomationHistorySchema,
  triggers: Schema.NonEmptyArray(AutomationTriggerInputSchema),
  enabled: Schema.optionalKey(Schema.Boolean),
  approval_mode: Schema.optionalKey(Schema.Literals(APPROVAL_MODES)),
  cooldown_minutes: Schema.optionalKey(Schema.NullOr(NonNegativeIntSchema))
} as const

const updateAutomationInputFields = {
  chat: Schema.optionalKey(AutomationChatChoiceSchema),
  name: Schema.optionalKey(TrimmedTextSchema),
  prompt: Schema.optionalKey(TrimmedTextSchema),
  description: Schema.optionalKey(DescriptionSchema),
  model: Schema.optionalKey(Schema.NullOr(TrimmedTextSchema)),
  history: Schema.optionalKey(AutomationHistorySchema),
  triggers: Schema.optionalKey(Schema.NonEmptyArray(AutomationTriggerInputSchema)),
  enabled: Schema.optionalKey(Schema.Boolean),
  cooldown_minutes: Schema.optionalKey(Schema.NullOr(NonNegativeIntSchema))
} as const

export const CreateAutomationInputSchema = Schema.Struct(createAutomationInputFields)

export const UpdateAutomationInputSchema = Schema.Struct(updateAutomationInputFields).check(
  Schema.makeFilter((request) =>
    Object.keys(request).length > 0 ? undefined : "an automation update requires at least one field"
  )
)

/** Internal create wire shape. Its retry identity is generated once. */
export const InternalCreateAutomationRequestSchema = Schema.Struct({
  ...createAutomationInputFields,
  idempotency_key: Schema.String.check(Schema.isUUID(4)),
  idempotency_scope: Schema.Literal("global")
})

export const AutomationRunStatusSchema = Schema.Literals([
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "interrupted"
] as const)

export const SystemAutomationSettingSchema = Schema.Literals([
  "triggers",
  "model",
  "prompt",
  "enabled"
] as const)

export const SystemAutomationSettingsSchema = withExtras({
  default_triggers: Schema.Array(AutomationTriggerSchema),
  settable: Schema.Array(SystemAutomationSettingSchema),
  changed: Schema.Array(SystemAutomationSettingSchema)
})

export const ResetAutomationSettingInputSchema = Schema.Struct({
  setting: SystemAutomationSettingSchema
})

export const AutomationChatSchema = Schema.Union([
  withExtras({ kind: Schema.Literal("own"), session_id: Schema.NonEmptyString }),
  withExtras({
    kind: Schema.Literal("yours"),
    session_id: Schema.NonEmptyString,
    own_session_id: Schema.NullOr(Schema.NonEmptyString)
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationSchema = withExtras({
  task_id: Schema.NonEmptyString,
  automation_ref: Schema.optionalKey(Schema.NonEmptyString),
  name: Schema.String,
  description: NullableTextSchema,
  description_source: Schema.NullOr(Schema.Literals(["manual", "generated"] as const)),
  prompt: Schema.String,
  model: NullableTextSchema,
  chat: Schema.NullOr(AutomationChatSchema),
  history: Schema.NullOr(AutomationHistorySchema),
  triggers: Schema.Array(AutomationTriggerSchema),
  enabled: Schema.Boolean,
  created_at: IsoDateTimeStringSchema,
  last_run_at: Schema.NullOr(IsoDateTimeStringSchema),
  next_run_at: Schema.NullOr(IsoDateTimeStringSchema),
  recent_statuses: Schema.Array(AutomationRunStatusSchema),
  latest_run_id: Schema.NullOr(NonNegativeIntSchema),
  last_result: NullableTextSchema,
  auto_approve: Schema.Boolean,
  running_since: Schema.NullOr(IsoDateTimeStringSchema),
  waiting_on: Schema.NullOr(Schema.Literals(["approval", "connection"] as const)),
  /** Event rows the Automation matched that no run has started: a paused one keeps them for its resume. */
  waiting_events: NonNegativeIntSchema,
  pending_approvals: Schema.NullOr(
    withExtras({
      count: NonNegativeIntSchema,
      first: withExtras({
        run_id: Schema.NonEmptyString,
        tool_call_id: Schema.NonEmptyString,
        session_id: Schema.NonEmptyString,
        destination_session_id: Schema.NonEmptyString
      })
    })
  ),
  handler: NullableTextSchema,
  builtin: Schema.Boolean,
  cooldown_minutes: Schema.NullOr(NonNegativeIntSchema),
  old_conditions: Schema.Array(
    withExtras({
      trigger_id: TriggerIdSchema,
      words: Schema.NonEmptyString,
      readable: Schema.Boolean
    })
  ),
  tool_scope: AutomationToolScopeSchema,
  tool_scope_label: Schema.String,
  manual_run: Schema.Boolean,
  system: Schema.NullOr(SystemAutomationSettingsSchema)
}).check(
  Schema.makeFilter((automation) => {
    if (automation.system !== null) {
      return automation.history === null
        ? undefined
        : { path: ["history"], issue: "must be null for a system automation" }
    }
    if (automation.history === null) {
      return { path: ["history"], issue: "is required for a user's automation" }
    }
    return automation.chat !== null
      ? undefined
      : { path: ["chat"], issue: "is required for a user's automation" }
  })
)

export const AutomationListResponseSchema = withExtras({
  automations: Schema.Array(AutomationSchema)
})

const QueryLimitSchema = Schema.Union([Schema.Number, Schema.NumberFromString]).check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 200 })
)

export const AutomationRunsQuerySchema = withExtras({
  limit: Schema.optionalKey(QueryLimitSchema)
})

const AutomationEventLinkSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat"),
    session_id: Schema.NonEmptyString,
    session_ref: Schema.NonEmptyString
  }),
  Schema.Struct({ kind: Schema.Literal("memory_page"), path: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("task"), item_id: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("connection_item"),
    item_id: Schema.NonEmptyString,
    url: Schema.NullOr(Schema.NonEmptyString)
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationSkippedEventSchema = Schema.Struct({
  event_type: AutomationEventTypeSchema,
  title: Schema.NonEmptyString,
  link: Schema.NullOr(AutomationEventLinkSchema)
})

/** Why an occurrence ended before any run: its "Run only if" sentences said no to its event. */
export const AutomationRunSkipSchema = Schema.Struct({
  reason: Schema.Literal("prefilter"),
  /** `llm` for the Helper, else the decision endpoint's id. */
  backend: Schema.NonEmptyString,
  event: AutomationSkippedEventSchema,
  asked: Schema.Array(Schema.NonEmptyString),
  /** "Ran by you": the run you started with this event; `run_id` is null while it waits. */
  ran: Schema.NullOr(
    Schema.Struct({ at: IsoDateTimeStringSchema, run_id: Schema.NullOr(PositiveIntSchema) })
  ),
  /** That run was cancelled before it started; `ran` is null again. */
  cancelled: Schema.NullOr(Schema.Struct({ at: IsoDateTimeStringSchema }))
})

export const AutomationRunSchema = withExtras({
  id: PositiveIntSchema,
  task_id: Schema.NonEmptyString,
  chat_run_id: Schema.NullOr(Schema.String),
  chat_session_id: Schema.NullOr(Schema.String),
  context_mode: Schema.Literals(["fresh", "continue", "fork"] as const),
  started_at: IsoDateTimeStringSchema,
  ended_at: Schema.NullOr(IsoDateTimeStringSchema),
  status: AutomationRunStatusSchema,
  result: NullableTextSchema,
  error: NullableTextSchema,
  skipped: Schema.NullOr(AutomationRunSkipSchema)
}).check(
  Schema.makeFilter((run) => {
    if (run.status === "running") {
      return run.ended_at === null
        ? undefined
        : { path: ["ended_at"], issue: "must be null while a run is active" }
    }
    return run.ended_at !== null
      ? undefined
      : { path: ["ended_at"], issue: "is required for a terminal run" }
  })
)

export const AutomationRunsResponseSchema: Schema.Codec<AutomationRunsResponse> = withExtras({
  runs: Schema.Array(AutomationRunSchema)
})

export const AutomationEventCatalogFieldSchema = withExtras({
  field: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  hint: Schema.String,
  type: Schema.Literals(["int", "float", "str", "bool", "list"] as const),
  operators: Schema.Array(AutomationConditionOperatorSchema)
})

export const AutomationEventCatalogEntrySchema = withExtras({
  event_type: AutomationEventTypeSchema,
  label: Schema.NonEmptyString,
  fields: Schema.Array(AutomationEventCatalogFieldSchema)
})

export const AutomationEventCatalogResponseSchema: Schema.Codec<AutomationEventCatalogResponse> =
  withExtras({
    events: Schema.Array(AutomationEventCatalogEntrySchema)
  })

export const ToggleAutomationResponseSchema: Schema.Codec<ToggleAutomationResponse> = withExtras({
  enabled: Schema.Boolean
})

export const RunAutomationResponseSchema: Schema.Codec<RunAutomationResponse> = withExtras({
  status: Schema.Literal("started")
})

export const DeleteAutomationResponseSchema: Schema.Codec<DeleteAutomationResponse> = withExtras({
  status: Schema.Literal("deleted")
})

/** Idempotency bookkeeping stays on the server; clients never see it. */
export const toAutomation = (automation: typeof AutomationSchema.Type): Automation => {
  const { idempotency_key: _key, idempotency_scope: _scope, ...rest } = automation
  return rest
}

export const toAutomationList = (
  response: typeof AutomationListResponseSchema.Type
): AutomationListResponse => ({
  ...response,
  automations: response.automations.map(toAutomation)
})

export const decodeAutomationRunsQueryEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(AutomationRunsQuerySchema)(value).pipe(
    Effect.map((query) => ({ ...query, limit: query.limit ?? 20 }))
  )

export const encodeCreateAutomationRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateAutomationInputSchema)(value, strict).pipe(
    Effect.map((input) => ({
      ...input,
      idempotency_key: globalThis.crypto.randomUUID(),
      idempotency_scope: "global" as const
    })),
    Effect.flatMap((request) =>
      Schema.decodeUnknownEffect(InternalCreateAutomationRequestSchema)(request, strict)
    ),
    Effect.map(JSON.stringify)
  )

export const encodeResetAutomationSettingRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ResetAutomationSettingInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeUpdateAutomationRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(UpdateAutomationInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

/** @internal Compile-time check that the schema and the type agree. */
export type AutomationRunStatusAgrees = Assert<
  Agrees<(typeof AutomationRunStatusSchema)["Type"], AutomationRunStatus>
>
