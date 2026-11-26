import { Schema } from "effect"
import type { Automation, AutomationHistory, AutomationListResponse } from "./contracts.js"
import { AUTOMATION_CHAT_CHOICE, AUTOMATION_WAITING_ON } from "./contracts.js"
import { IsoDateTimeStringSchema, NonNegativeIntSchema, withExtras } from "../common/schema.js"
import {
  AutomationHistorySchema,
  AutomationRunStatusSchema,
  AutomationToolScopeSchema,
  SystemAutomationSettingsSchema
} from "./schema.js"
import { AutomationTriggerSchema, TriggerIdSchema } from "./trigger-schema.js"

export const AutomationOwnChatSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("chat"), session_id: Schema.NonEmptyString })
]).pipe(Schema.toTaggedUnion("kind"))

const ownChatFields = {
  kind: Schema.Literal(AUTOMATION_CHAT_CHOICE.own),
  session_id: Schema.NonEmptyString
}
const yourChatFields = {
  kind: Schema.Literal(AUTOMATION_CHAT_CHOICE.yours),
  session_id: Schema.NonEmptyString,
  own_chat: AutomationOwnChatSchema
}

export const AutomationChatSchema = Schema.Union([
  withExtras(ownChatFields),
  withExtras(yourChatFields)
]).pipe(Schema.toTaggedUnion("kind"))

export const SystemAutomationChatSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  withExtras(ownChatFields),
  withExtras(yourChatFields)
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationDescriptionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("manual"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("generated"), text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationModelSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("inherited") }),
  Schema.Struct({ kind: Schema.Literal("chosen"), model_id: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationLastRunSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("never") }),
  Schema.Struct({ kind: Schema.Literal("ran"), at: IsoDateTimeStringSchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationLastResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationNextRunSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unscheduled") }),
  Schema.Struct({ kind: Schema.Literal("scheduled"), at: IsoDateTimeStringSchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationActivitySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({ kind: Schema.Literal("running"), since: IsoDateTimeStringSchema }),
  Schema.Struct({
    kind: Schema.Literal("waiting"),
    since: IsoDateTimeStringSchema,
    on: Schema.Literals(Object.values(AUTOMATION_WAITING_ON))
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationPendingApprovalsSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("pending"),
    count: NonNegativeIntSchema,
    first: withExtras({
      run_id: Schema.NonEmptyString,
      tool_call_id: Schema.NonEmptyString,
      session_id: Schema.NonEmptyString,
      destination_session_id: Schema.NonEmptyString
    })
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationCooldownSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("minutes"), minutes: NonNegativeIntSchema })
]).pipe(Schema.toTaggedUnion("kind"))

const automationFields = {
  task_id: Schema.NonEmptyString,
  automation_ref: Schema.NonEmptyString,
  name: Schema.String,
  description: AutomationDescriptionSchema,
  prompt: Schema.String,
  model: AutomationModelSchema,
  triggers: Schema.Array(AutomationTriggerSchema),
  enabled: Schema.Boolean,
  created_at: IsoDateTimeStringSchema,
  last_run: AutomationLastRunSchema,
  next_run: AutomationNextRunSchema,
  recent_statuses: Schema.Array(AutomationRunStatusSchema),
  last_result: AutomationLastResultSchema,
  auto_approve: Schema.Boolean,
  activity: AutomationActivitySchema,
  waiting_events: NonNegativeIntSchema,
  pending_approvals: AutomationPendingApprovalsSchema,
  builtin: Schema.Boolean,
  cooldown: AutomationCooldownSchema,
  old_conditions: Schema.Array(
    withExtras({
      trigger_id: TriggerIdSchema,
      words: Schema.NonEmptyString,
      readable: Schema.Boolean
    })
  ),
  tool_scope: AutomationToolScopeSchema,
  tool_scope_label: Schema.String
} as const

export const AutomationSchema = Schema.Union([
  withExtras({
    ...automationFields,
    kind: Schema.Literal("user"),
    chat: AutomationChatSchema,
    history: AutomationHistorySchema
  }),
  withExtras({
    ...automationFields,
    kind: Schema.Literal("system"),
    handler: Schema.NonEmptyString,
    chat: SystemAutomationChatSchema,
    manual_run: Schema.Boolean,
    settings: SystemAutomationSettingsSchema
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationListResponseSchema = withExtras({
  automations: Schema.Array(AutomationSchema)
})

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

const READS_CHAT: Record<AutomationHistory, boolean> = { fresh: false, chat: true }

export const automationPermissionChat = (automation: Automation): string | null =>
  SystemAutomationChatSchema.match(automation.chat, {
    none: () => null,
    own: ({ session_id }) => session_id,
    yours: ({ session_id, own_chat }) =>
      AutomationSchema.guards.user(automation) && READS_CHAT[automation.history]
        ? session_id
        : AutomationOwnChatSchema.match(own_chat, {
            none: () => null,
            chat: (chat) => chat.session_id
          })
  })
