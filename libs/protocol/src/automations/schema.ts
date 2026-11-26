import { Effect, Schema } from "effect"
import type { Agrees, Assert } from "../common/type-agreement.js"
import type {
  AutomationRunStatus,
  AutomationEventCatalogResponse,
  DeleteAutomationResponse,
  RunAutomationResponse,
  ToggleAutomationResponse
} from "./contracts.js"
import { withExtras, NonNegativeIntSchema } from "../common/schema.js"
import { AUTOMATION_EVENT_TYPES } from "./triggers.js"
import {
  AutomationConditionOperatorSchema,
  AutomationTriggerInputSchema,
  AutomationTriggerSpecInputSchema,
  AutomationTriggerSpecSchema
} from "./trigger-schema.js"
import { APPROVAL_MODES } from "../permissions/modes.js"

const strict = { onExcessProperty: "error" } as const
const TrimmedTextSchema = Schema.Trim.check(Schema.isMinLength(1))
const DescriptionSchema = TrimmedTextSchema.check(Schema.isMaxLength(220))
export const AutomationTextSchema = TrimmedTextSchema
export const AutomationDescriptionTextSchema = DescriptionSchema
const AutomationEventTypeSchema = Schema.Literals(AUTOMATION_EVENT_TYPES)

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

const TriggerInputsSchema = Schema.Array(AutomationTriggerInputSchema).check(Schema.isMinLength(1))
const TriggerSpecsSchema = Schema.Array(AutomationTriggerSpecInputSchema).check(
  Schema.isMinLength(1)
)

const AutomationModelInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("inherited") }),
  Schema.Struct({ kind: Schema.Literal("chosen"), model_id: TrimmedTextSchema })
]).pipe(Schema.toTaggedUnion("kind"))

const AutomationCooldownInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("minutes"), minutes: NonNegativeIntSchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationDescriptionInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("manual"), text: DescriptionSchema })
]).pipe(Schema.toTaggedUnion("kind"))

const createAutomationInputFields = {
  chat: AutomationChatChoiceSchema,
  name: TrimmedTextSchema,
  prompt: TrimmedTextSchema,
  description: AutomationDescriptionInputSchema,
  model: AutomationModelInputSchema,
  history: AutomationHistorySchema,
  triggers: TriggerSpecsSchema,
  enabled: Schema.Boolean,
  approval_mode: Schema.Literals(APPROVAL_MODES),
  cooldown: AutomationCooldownInputSchema
} as const

export const CreateAutomationInputSchema = Schema.Struct(createAutomationInputFields)

export const AutomationChangeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat"), chat: AutomationChatChoiceSchema }),
  Schema.Struct({ kind: Schema.Literal("name"), name: TrimmedTextSchema }),
  Schema.Struct({ kind: Schema.Literal("prompt"), prompt: TrimmedTextSchema }),
  Schema.Struct({ kind: Schema.Literal("description"), description: DescriptionSchema }),
  Schema.Struct({ kind: Schema.Literal("model"), model: AutomationModelInputSchema }),
  Schema.Struct({ kind: Schema.Literal("history"), history: AutomationHistorySchema }),
  Schema.Struct({
    kind: Schema.Literal("triggers"),
    triggers: TriggerInputsSchema
  }),
  Schema.Struct({ kind: Schema.Literal("enabled"), enabled: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("cooldown"), cooldown: AutomationCooldownInputSchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const UpdateAutomationInputSchema = Schema.Struct({
  changes: Schema.Array(AutomationChangeSchema).check(
    Schema.makeFilter((changes) => {
      if (changes.length === 0) return "an automation update requires at least one change"
      const kinds = new Set(changes.map((change) => change.kind))
      return kinds.size === changes.length ? undefined : "each setting changes at most once"
    })
  )
})

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
  default_triggers: Schema.Array(AutomationTriggerSpecSchema),
  settable: Schema.Array(SystemAutomationSettingSchema),
  changed: Schema.Array(SystemAutomationSettingSchema)
})

export const ResetAutomationSettingInputSchema = Schema.Struct({
  setting: SystemAutomationSettingSchema
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

export const encodeCreateAutomationRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
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

export const encodeResetAutomationSettingRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ResetAutomationSettingInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeUpdateAutomationRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(UpdateAutomationInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

/** @internal Compile-time check that the schema and the type agree. */
export type AutomationRunStatusAgrees = Assert<
  Agrees<(typeof AutomationRunStatusSchema)["Type"], AutomationRunStatus>
>
