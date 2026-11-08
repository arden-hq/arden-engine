import { Effect, Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"
import type {
  StorageCategory,
  StorageCleanupAction,
  StorageCleanupContext,
  StorageCleanupPlan,
  StorageCleanupRun,
  StorageOverview,
  StorageSettings,
  StorageStatus
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))
const SessionIdSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(255))
const MaxSpaceGiBSchema = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0.1),
  Schema.isLessThanOrEqualTo(1_000_000)
)
export const StoragePlanIdSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

const StorageCategoryIdSchema = Schema.Literals([
  "chats",
  "channels",
  "agents",
  "knowledge",
  "skills",
  "housekeeping",
  "other"
] as const)

export const StorageCategoryResponseSchema = withExtras({
  id: StorageCategoryIdSchema,
  label: NonEmptyTextSchema,
  total_bytes: NonNegativeIntSchema,
  item_count: NonNegativeIntSchema,
  description: Schema.String.check(Schema.isMaxLength(4_096)),
  detail: Schema.String.check(Schema.isMaxLength(4_096))
})

export const StorageStatusResponseSchema = withExtras({
  total_bytes: NonNegativeIntSchema,
  max_bytes: Schema.NullOr(PositiveIntSchema),
  over_budget_bytes: NonNegativeIntSchema,
  checked_at: IsoDateTimeStringSchema,
  categories: Schema.Array(StorageCategoryResponseSchema)
}).check(
  Schema.makeFilter((status) => {
    const ids = new Set(status.categories.map((category) => category.id))
    if (ids.size !== status.categories.length) {
      return { path: ["categories"], issue: "must not contain duplicate category IDs" }
    }
    const total = status.categories.reduce((sum, category) => sum + category.total_bytes, 0)
    if (total !== status.total_bytes) {
      return { path: ["categories"], issue: "totals must equal total_bytes" }
    }
    const overBudget =
      status.max_bytes === null ? 0 : Math.max(0, status.total_bytes - status.max_bytes)
    return overBudget === status.over_budget_bytes
      ? undefined
      : { path: ["over_budget_bytes"], issue: "must match total_bytes and max_bytes" }
  })
)

export const StorageSettingsResponseSchema = withExtras({
  max_space_gib: Schema.NullOr(MaxSpaceGiBSchema),
  allow_archived_session_deletion: Schema.Boolean,
  allow_inactive_session_deletion: Schema.Boolean,
  inactive_session_days: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(3_650)),
  minimum_current_sessions: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(100_000))
})

export const StorageOverviewResponseSchema = withExtras({
  status: StorageStatusResponseSchema,
  settings: StorageSettingsResponseSchema
})

export const StorageCleanupActionResponseSchema = withExtras({
  kind: Schema.Literals(["delete_archived_session", "delete_inactive_session"] as const),
  resource_id: NonEmptyTextSchema,
  name: NonEmptyTextSchema,
  size_bytes: NonNegativeIntSchema,
  agents: NonNegativeIntSchema,
  side_chats: NonNegativeIntSchema,
  description: Schema.String.check(Schema.isMaxLength(4_096))
})

export const StorageCleanupPlanResponseSchema = withExtras({
  plan_id: StoragePlanIdSchema,
  before_bytes: NonNegativeIntSchema,
  budget_bytes: Schema.NullOr(PositiveIntSchema),
  target_bytes: Schema.NullOr(PositiveIntSchema),
  estimated_after_bytes: NonNegativeIntSchema,
  estimated_reclaimable_bytes: NonNegativeIntSchema,
  attainable: Schema.Boolean,
  actions: Schema.Array(StorageCleanupActionResponseSchema),
  blockers: Schema.Array(NonEmptyTextSchema),
  created_at: IsoDateTimeStringSchema
}).check(
  Schema.makeFilter((plan) => {
    const ids = new Set(plan.actions.map((action) => `${action.kind}:${action.resource_id}`))
    if (ids.size !== plan.actions.length) {
      return { path: ["actions"], issue: "must not contain duplicate action identities" }
    }
    const total = plan.actions.reduce((sum, action) => sum + action.size_bytes, 0)
    if (total !== plan.estimated_reclaimable_bytes) {
      return { path: ["estimated_reclaimable_bytes"], issue: "must equal the action total" }
    }
    const after = Math.max(0, plan.before_bytes - plan.estimated_reclaimable_bytes)
    if (after !== plan.estimated_after_bytes) {
      return { path: ["estimated_after_bytes"], issue: "must match the action total" }
    }
    if ((plan.budget_bytes === null) !== (plan.target_bytes === null)) {
      return { path: ["target_bytes"], issue: "must be absent exactly when budget_bytes is absent" }
    }
    if (
      plan.budget_bytes !== null &&
      plan.target_bytes !== null &&
      plan.target_bytes > plan.budget_bytes
    ) {
      return { path: ["target_bytes"], issue: "must not exceed budget_bytes" }
    }
    const attainable = plan.target_bytes === null || after <= plan.target_bytes
    return attainable === plan.attainable
      ? undefined
      : { path: ["attainable"], issue: "must match estimated_after_bytes and budget_bytes" }
  })
)

export const StorageCleanupRunResponseSchema = withExtras({
  plan_id: StoragePlanIdSchema,
  reclaimed_bytes: NonNegativeIntSchema,
  actions_completed: NonNegativeIntSchema,
  overview: StorageOverviewResponseSchema
})

export const StorageSettingsPatchRequestSchema = Schema.Struct({
  max_space_gib: Schema.NullOr(MaxSpaceGiBSchema),
  allow_archived_session_deletion: Schema.Boolean,
  allow_inactive_session_deletion: Schema.Boolean,
  inactive_session_days: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(3_650)),
  minimum_current_sessions: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(100_000))
})

export const StorageCleanupContextRequestSchema = Schema.Struct({
  current_session_id: Schema.NullOr(SessionIdSchema),
  pinned_session_ids: Schema.Array(SessionIdSchema)
}).check(
  Schema.makeFilter((context) => {
    const ids = new Set(context.pinned_session_ids)
    return ids.size === context.pinned_session_ids.length
      ? undefined
      : { path: ["pinned_session_ids"], issue: "must not contain duplicates" }
  })
)
export const StorageCleanupRequestSchema = Schema.Struct({
  plan_id: StoragePlanIdSchema,
  ...StorageCleanupContextRequestSchema.fields
})

const StorageSettingsPatchInputSchema = Schema.Struct({
  maxSpaceGiB: Schema.NullOr(MaxSpaceGiBSchema),
  allowArchivedSessionDeletion: Schema.Boolean,
  allowInactiveSessionDeletion: Schema.Boolean,
  inactiveSessionDays: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(3_650)),
  minimumCurrentSessions: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(100_000))
})
const StorageCleanupContextInputSchema = Schema.Struct({
  currentSessionId: Schema.NullOr(SessionIdSchema),
  pinnedSessionIds: Schema.Array(SessionIdSchema)
}).check(
  Schema.makeFilter((context) => {
    const ids = new Set(context.pinnedSessionIds)
    return ids.size === context.pinnedSessionIds.length
      ? undefined
      : { path: ["pinnedSessionIds"], issue: "must not contain duplicates" }
  })
)

type StorageCategoryWire = Schema.Schema.Type<typeof StorageCategoryResponseSchema>
type StorageStatusWire = Schema.Schema.Type<typeof StorageStatusResponseSchema>
type StorageSettingsWire = Schema.Schema.Type<typeof StorageSettingsResponseSchema>
type StorageOverviewWire = Schema.Schema.Type<typeof StorageOverviewResponseSchema>
type StorageCleanupActionWire = Schema.Schema.Type<typeof StorageCleanupActionResponseSchema>
type StorageCleanupPlanWire = Schema.Schema.Type<typeof StorageCleanupPlanResponseSchema>
type StorageCleanupRunWire = Schema.Schema.Type<typeof StorageCleanupRunResponseSchema>

const storagePlanIds = new WeakMap<StorageCleanupPlan, string>()

const mapCategory = (category: StorageCategoryWire): StorageCategory => ({
  id: category.id,
  label: category.label,
  totalBytes: category.total_bytes,
  itemCount: category.item_count,
  description: category.description,
  detail: category.detail
})

const mapStatus = (status: StorageStatusWire): StorageStatus => ({
  totalBytes: status.total_bytes,
  maxBytes: status.max_bytes,
  overBudgetBytes: status.over_budget_bytes,
  checkedAt: status.checked_at,
  categories: status.categories.map(mapCategory)
})

const mapSettings = (settings: StorageSettingsWire): StorageSettings => ({
  maxSpaceGiB: settings.max_space_gib,
  allowArchivedSessionDeletion: settings.allow_archived_session_deletion,
  allowInactiveSessionDeletion: settings.allow_inactive_session_deletion,
  inactiveSessionDays: settings.inactive_session_days,
  minimumCurrentSessions: settings.minimum_current_sessions
})

export const mapOverview = (overview: StorageOverviewWire): StorageOverview => ({
  status: mapStatus(overview.status),
  settings: mapSettings(overview.settings)
})

const mapAction = (action: StorageCleanupActionWire): StorageCleanupAction => ({
  kind: action.kind,
  resourceId: action.resource_id,
  name: action.name,
  sizeBytes: action.size_bytes,
  agents: action.agents,
  sideChats: action.side_chats,
  description: action.description
})

const mapPlan = (plan: StorageCleanupPlanWire): StorageCleanupPlan => {
  const mapped: StorageCleanupPlan = {
    beforeBytes: plan.before_bytes,
    budgetBytes: plan.budget_bytes,
    targetBytes: plan.target_bytes,
    estimatedAfterBytes: plan.estimated_after_bytes,
    estimatedReclaimableBytes: plan.estimated_reclaimable_bytes,
    attainable: plan.attainable,
    actions: plan.actions.map(mapAction),
    blockers: [...plan.blockers],
    createdAt: plan.created_at
  }
  storagePlanIds.set(mapped, plan.plan_id)
  return mapped
}

const mapRun = (run: StorageCleanupRunWire): StorageCleanupRun => ({
  reclaimedBytes: run.reclaimed_bytes,
  actionsCompleted: run.actions_completed,
  overview: mapOverview(run.overview)
})

export const getStoragePlanId = (plan: StorageCleanupPlan): string | undefined =>
  storagePlanIds.get(plan)

export const decodeStorageCleanupPlanEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(StorageCleanupPlanResponseSchema)(value).pipe(Effect.map(mapPlan))

export const decodeStorageCleanupRunForPlanEffect = (
  value: unknown,
  expectedPlanId: string,
  maxActions: number
) =>
  Schema.decodeUnknownEffect(
    StorageCleanupRunResponseSchema.check(
      Schema.makeFilter((run) => {
        if (run.plan_id !== expectedPlanId) {
          return { path: ["plan_id"], issue: "does not match the requested cleanup plan" }
        }
        if (run.actions_completed > maxActions) {
          return { path: ["actions_completed"], issue: "exceeds the requested cleanup plan" }
        }
        return undefined
      })
    )
  )(value).pipe(Effect.map(mapRun))

export const encodeStorageSettingsPatchEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(StorageSettingsPatchInputSchema)(value, strict).pipe(
    Effect.map((settings) =>
      JSON.stringify({
        max_space_gib: settings.maxSpaceGiB,
        allow_archived_session_deletion: settings.allowArchivedSessionDeletion,
        allow_inactive_session_deletion: settings.allowInactiveSessionDeletion,
        inactive_session_days: settings.inactiveSessionDays,
        minimum_current_sessions: settings.minimumCurrentSessions
      })
    )
  )

export const encodeStorageCleanupContextEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(StorageCleanupContextInputSchema)(value, strict).pipe(
    Effect.map((context) =>
      JSON.stringify({
        current_session_id: context.currentSessionId,
        pinned_session_ids: context.pinnedSessionIds
      })
    )
  )

export const encodeStorageCleanupRequestEffect = (
  planId: unknown,
  context: StorageCleanupContext
) =>
  Schema.decodeUnknownEffect(StoragePlanIdSchema)(planId).pipe(
    Effect.flatMap((validPlanId) =>
      Schema.decodeUnknownEffect(StorageCleanupContextInputSchema)(context, strict).pipe(
        Effect.map((validContext) =>
          JSON.stringify({
            plan_id: validPlanId,
            current_session_id: validContext.currentSessionId,
            pinned_session_ids: validContext.pinnedSessionIds
          })
        )
      )
    )
  )
