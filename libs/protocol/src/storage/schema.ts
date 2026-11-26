import { Effect, Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"
import {
  STORAGE_CURRENT_SESSION,
  STORAGE_LIMIT,
  type StorageCategory,
  type StorageCleanupAction,
  type StorageCleanupContext,
  type StorageCleanupPlan,
  type StorageCleanupRun,
  type StorageOverview,
  type StorageSettings,
  type StorageStatus
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))
const SessionIdSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(255))
const MaxSpaceGiBSchema = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0.1),
  Schema.isLessThanOrEqualTo(1_000_000)
)
const MaxSpaceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(STORAGE_LIMIT.unlimited) }),
  Schema.Struct({ kind: Schema.Literal(STORAGE_LIMIT.limited), gib: MaxSpaceGiBSchema })
])
const CurrentSessionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(STORAGE_CURRENT_SESSION.none) }),
  Schema.Struct({
    kind: Schema.Literal(STORAGE_CURRENT_SESSION.session),
    session_id: SessionIdSchema
  })
])
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
  budget: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(STORAGE_LIMIT.unlimited) }),
    Schema.Struct({
      kind: Schema.Literal(STORAGE_LIMIT.limited),
      max_bytes: PositiveIntSchema,
      over_budget_bytes: NonNegativeIntSchema
    })
  ]),
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
    const budget = status.budget
    return budget.kind === STORAGE_LIMIT.unlimited ||
      Math.max(0, status.total_bytes - budget.max_bytes) === budget.over_budget_bytes
      ? undefined
      : { path: ["budget"], issue: "must match total_bytes and max_bytes" }
  })
)

export const StorageSettingsResponseSchema = withExtras({
  max_space: MaxSpaceSchema,
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
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(STORAGE_LIMIT.unlimited) }),
    Schema.Struct({
      kind: Schema.Literal(STORAGE_LIMIT.limited),
      budget_bytes: PositiveIntSchema,
      target_bytes: PositiveIntSchema
    })
  ]),
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
    const target = plan.target
    if (target.kind === STORAGE_LIMIT.limited && target.target_bytes > target.budget_bytes) {
      return { path: ["target"], issue: "must not exceed budget_bytes" }
    }
    const attainable = target.kind === STORAGE_LIMIT.unlimited || after <= target.target_bytes
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
  max_space: MaxSpaceSchema,
  allow_archived_session_deletion: Schema.Boolean,
  allow_inactive_session_deletion: Schema.Boolean,
  inactive_session_days: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(3_650)),
  minimum_current_sessions: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(100_000))
})

export const StorageCleanupContextRequestSchema = Schema.Struct({
  current_session: CurrentSessionSchema,
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
  maxSpace: MaxSpaceSchema,
  allowArchivedSessionDeletion: Schema.Boolean,
  allowInactiveSessionDeletion: Schema.Boolean,
  inactiveSessionDays: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(3_650)),
  minimumCurrentSessions: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(100_000))
})
const StorageCleanupContextInputSchema = Schema.Struct({
  currentSession: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(STORAGE_CURRENT_SESSION.none) }),
    Schema.Struct({
      kind: Schema.Literal(STORAGE_CURRENT_SESSION.session),
      sessionId: SessionIdSchema
    })
  ]),
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
  budget:
    status.budget.kind === STORAGE_LIMIT.limited
      ? {
          kind: status.budget.kind,
          maxBytes: status.budget.max_bytes,
          overBudgetBytes: status.budget.over_budget_bytes
        }
      : status.budget,
  checkedAt: status.checked_at,
  categories: status.categories.map(mapCategory)
})

export const mapSettings = (settings: StorageSettingsWire): StorageSettings => ({
  maxSpace: settings.max_space,
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
    target:
      plan.target.kind === STORAGE_LIMIT.limited
        ? {
            kind: plan.target.kind,
            budgetBytes: plan.target.budget_bytes,
            targetBytes: plan.target.target_bytes
          }
        : plan.target,
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

export const decodeStorageCleanupPlanEffect = (
  value: unknown
): Effect.Effect<StorageCleanupPlan, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(StorageCleanupPlanResponseSchema)(value).pipe(Effect.map(mapPlan))

export const decodeStorageCleanupRunForPlanEffect = (
  value: unknown,
  expectedPlanId: string,
  maxActions: number
): Effect.Effect<StorageCleanupRun, Schema.SchemaError, never> =>
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

export const encodeStorageSettingsPatchEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(StorageSettingsPatchInputSchema)(value, strict).pipe(
    Effect.map((settings) =>
      JSON.stringify({
        max_space: settings.maxSpace,
        allow_archived_session_deletion: settings.allowArchivedSessionDeletion,
        allow_inactive_session_deletion: settings.allowInactiveSessionDeletion,
        inactive_session_days: settings.inactiveSessionDays,
        minimum_current_sessions: settings.minimumCurrentSessions
      })
    )
  )

export const currentSessionToWire = (
  current: StorageCleanupContext["currentSession"]
): typeof CurrentSessionSchema.Type =>
  current.kind === STORAGE_CURRENT_SESSION.session
    ? { kind: current.kind, session_id: current.sessionId }
    : current

export const currentSessionFromWire = (
  current: typeof CurrentSessionSchema.Type
): StorageCleanupContext["currentSession"] =>
  current.kind === STORAGE_CURRENT_SESSION.session
    ? { kind: current.kind, sessionId: current.session_id }
    : current

export const encodeStorageCleanupContextEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(StorageCleanupContextInputSchema)(value, strict).pipe(
    Effect.map((context) =>
      JSON.stringify({
        current_session: currentSessionToWire(context.currentSession),
        pinned_session_ids: context.pinnedSessionIds
      })
    )
  )

export const encodeStorageCleanupRequestEffect = (
  planId: unknown,
  context: StorageCleanupContext
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(StoragePlanIdSchema)(planId).pipe(
    Effect.flatMap((validPlanId) =>
      Schema.decodeUnknownEffect(StorageCleanupContextInputSchema)(context, strict).pipe(
        Effect.map((validContext) =>
          JSON.stringify({
            plan_id: validPlanId,
            current_session: currentSessionToWire(validContext.currentSession),
            pinned_session_ids: validContext.pinnedSessionIds
          })
        )
      )
    )
  )
