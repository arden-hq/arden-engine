import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras, NonNegativeIntSchema } from "../common/schema.js"
import { checkRunApprovalConnection, runApprovalFields } from "../runs/approval-schema.js"
import { RunQuestionSchema } from "../runs/questions.js"
import { INBOX_ITEM_LIMIT } from "./contracts.js"
import type { InboxView } from "./contracts.js"

const inboxItemBase = {
  key: Schema.String,
  group_key: Schema.String,
  at: IsoDateTimeStringSchema,
  counted: Schema.Boolean,
  unread: Schema.Boolean,
  read_at: Schema.NullOr(IsoDateTimeStringSchema)
} as const

export const InboxBlockedTaskItemSchema = withExtras({
  ...inboxItemBase,
  source: Schema.Literal("blocked_task"),
  space_id: Schema.NullOr(Schema.String),
  space_title: Schema.NullOr(Schema.String),
  item_id: Schema.String,
  stable_key: Schema.String,
  seq: Schema.NullOr(NonNegativeIntSchema),
  text: Schema.String,
  waiting_on: Schema.Literals(["you", "external"] as const),
  question: Schema.NullOr(Schema.String),
  question_at: Schema.NullOr(IsoDateTimeStringSchema)
})

export const InboxApprovalItemSchema = withExtras({
  ...inboxItemBase,
  source: Schema.Literal("approval"),
  ...runApprovalFields
}).check(Schema.makeFilter(checkRunApprovalConnection))

export const InboxFailureGroupItemSchema = withExtras({
  ...inboxItemBase,
  source: Schema.Literal("failure"),
  space_id: Schema.NullOr(Schema.String),
  space_title: Schema.NullOr(Schema.String),
  automation_task_id: Schema.NullOr(Schema.String),
  run_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workflow_ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cause: Schema.String,
  run_count: NonNegativeIntSchema,
  first_at: IsoDateTimeStringSchema,
  last_at: IsoDateTimeStringSchema,
  automation_paused: Schema.Boolean
})

export const InboxIncidentItemSchema = withExtras({
  ...inboxItemBase,
  source: Schema.Literal("incident"),
  incident_id: Schema.String,
  code: Schema.Literal("delivery.unroutable"),
  summary: Schema.String,
  delivery_id: Schema.String,
  source_run_id: Schema.String
})

export const InboxPlanLimitItemSchema = withExtras({
  ...inboxItemBase,
  source: Schema.Literal("plan_limit"),
  level: Schema.Literals(["background", "arden", "used_up"]),
  used_percent: Schema.Number,
  limit_percent: Schema.NullOr(Schema.Number),
  window_seconds: Schema.Number,
  resets_at: IsoDateTimeStringSchema
})

export const InboxItemSchema = Schema.Union([
  withExtras({ ...inboxItemBase, source: Schema.Literal("question"), question: RunQuestionSchema }),
  InboxBlockedTaskItemSchema,
  InboxApprovalItemSchema,
  InboxIncidentItemSchema,
  InboxFailureGroupItemSchema,
  InboxPlanLimitItemSchema
]).pipe(Schema.toTaggedUnion("source"))

type InboxGroupKind = "space" | "questions" | "approvals" | "incidents" | "failures" | "limits"

/** The one item source each group kind holds. */
const SOURCE_BY_GROUP_KIND: Record<InboxGroupKind, (typeof InboxItemSchema)["Type"]["source"]> = {
  space: "blocked_task",
  questions: "question",
  approvals: "approval",
  incidents: "incident",
  failures: "failure",
  limits: "plan_limit"
}

export const InboxGroupSchema = withExtras({
  key: Schema.String,
  kind: Schema.Literals([
    "space",
    "questions",
    "approvals",
    "incidents",
    "failures",
    "limits"
  ] as const satisfies ReadonlyArray<InboxGroupKind>),
  title: Schema.String,
  space_id: Schema.NullOr(Schema.String),
  count: NonNegativeIntSchema,
  items: Schema.Array(InboxItemSchema)
}).check(
  Schema.makeFilter((group) =>
    group.items.every((item) => item.group_key === group.key)
      ? undefined
      : { path: ["items"], issue: "item group_key must match its group" }
  ),
  Schema.makeFilter((group) =>
    group.count === group.items.filter((item) => item.counted).length
      ? undefined
      : { path: ["count"], issue: "must equal the number of counted items" }
  ),
  Schema.makeFilter((group) =>
    group.items.every((item) => item.source === SOURCE_BY_GROUP_KIND[group.kind])
      ? undefined
      : { path: ["items"], issue: "item source does not match group kind" }
  )
)

export const InboxViewSchema: Schema.Codec<InboxView> = withExtras({
  generated_at: IsoDateTimeStringSchema,
  count: NonNegativeIntSchema,
  unread_count: NonNegativeIntSchema,
  total_items: NonNegativeIntSchema,
  truncated: Schema.Boolean,
  groups: Schema.Array(InboxGroupSchema)
}).check(
  Schema.makeFilter((view) => {
    const items = view.groups.flatMap((group) => group.items)
    const itemKeys = new Set(items.map((item) => item.key))
    const groupKeys = new Set(view.groups.map((group) => group.key))
    const renderedCount = view.groups.reduce((total, group) => total + group.count, 0)
    const renderedUnreadCount = items.filter((item) => item.counted && item.unread).length

    if (items.length > INBOX_ITEM_LIMIT)
      return { path: ["groups"], issue: "exceeds the Inbox item limit" }
    if (itemKeys.size !== items.length)
      return { path: ["groups"], issue: "contains duplicate item keys" }
    if (groupKeys.size !== view.groups.length)
      return { path: ["groups"], issue: "contains duplicate group keys" }
    if (view.unread_count > view.count)
      return { path: ["unread_count"], issue: "must not exceed count" }
    if (view.count > view.total_items)
      return { path: ["count"], issue: "must not exceed total_items" }
    if (view.count < renderedCount)
      return { path: ["count"], issue: "must cover rendered counted items" }
    if (view.unread_count < renderedUnreadCount) {
      return { path: ["unread_count"], issue: "must cover rendered unread counted items" }
    }
    if (view.total_items < items.length)
      return { path: ["total_items"], issue: "must cover rendered items" }
    if (!view.truncated && view.total_items !== items.length) {
      return { path: ["total_items"], issue: "must equal rendered items when not truncated" }
    }
    if (!view.truncated && view.count !== renderedCount) {
      return { path: ["count"], issue: "must equal rendered counted items when not truncated" }
    }
    if (!view.truncated && view.unread_count !== renderedUnreadCount) {
      return {
        path: ["unread_count"],
        issue: "must equal rendered unread counted items when not truncated"
      }
    }
    if (view.truncated && view.total_items <= items.length) {
      return { path: ["truncated"], issue: "requires omitted items" }
    }
    return undefined
  })
)

export const MarkAllInboxReadRequestSchema = Schema.Struct({
  scope: Schema.Literal("all")
})

export const MarkInboxItemsReadRequestSchema = Schema.Struct({
  scope: Schema.Literal("items"),
  keys: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(INBOX_ITEM_LIMIT)
  )
})

export const MarkInboxReadRequestSchema = Schema.Union([
  MarkAllInboxReadRequestSchema,
  MarkInboxItemsReadRequestSchema
]).pipe(Schema.toTaggedUnion("scope"))

export const DismissAllInboxRequestSchema = Schema.Struct({
  scope: Schema.Literal("all")
})

export const DismissInboxItemsRequestSchema = Schema.Struct({
  scope: Schema.Literal("items"),
  keys: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(INBOX_ITEM_LIMIT)
  )
})

export const DismissInboxGroupRequestSchema = Schema.Struct({
  scope: Schema.Literal("group"),
  group_key: Schema.String.check(Schema.isMinLength(1))
})

export const DismissInboxRequestSchema = Schema.Union([
  DismissAllInboxRequestSchema,
  DismissInboxGroupRequestSchema,
  DismissInboxItemsRequestSchema
]).pipe(Schema.toTaggedUnion("scope"))

export const decodeMarkInboxReadRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(MarkInboxReadRequestSchema)(value, { onExcessProperty: "error" })

export const encodeMarkInboxReadRequestEffect = (value: unknown) =>
  decodeMarkInboxReadRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const decodeDismissInboxRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(DismissInboxRequestSchema)(value, { onExcessProperty: "error" })

export const encodeDismissInboxRequestEffect = (value: unknown) =>
  decodeDismissInboxRequestEffect(value).pipe(Effect.map(JSON.stringify))
