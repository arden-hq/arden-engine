import type { StorageCleanupPlan, StorageOverview } from "@arden-hq/protocol/storage"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { StoragePolicyStore } from "../../persistence/storage/store.js"
import { StorageMaintenance } from "../../storage/service.js"
import { BackfillStore } from "../../persistence/backfills/store.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"

const overviewResponse = (overview: StorageOverview) => ({
  status: {
    total_bytes: overview.status.totalBytes,
    max_bytes: overview.status.maxBytes,
    over_budget_bytes: overview.status.overBudgetBytes,
    checked_at: overview.status.checkedAt,
    categories: overview.status.categories.map((category) => ({
      id: category.id,
      label: category.label,
      total_bytes: category.totalBytes,
      item_count: category.itemCount,
      description: category.description,
      detail: category.detail
    }))
  },
  settings: {
    max_space_gib: overview.settings.maxSpaceGiB,
    allow_archived_session_deletion: overview.settings.allowArchivedSessionDeletion,
    allow_inactive_session_deletion: overview.settings.allowInactiveSessionDeletion,
    inactive_session_days: overview.settings.inactiveSessionDays,
    minimum_current_sessions: overview.settings.minimumCurrentSessions
  }
})

const cleanupPlanResponse = (id: string, plan: StorageCleanupPlan) => ({
  plan_id: id,
  before_bytes: plan.beforeBytes,
  budget_bytes: plan.budgetBytes,
  target_bytes: plan.targetBytes,
  estimated_after_bytes: plan.estimatedAfterBytes,
  estimated_reclaimable_bytes: plan.estimatedReclaimableBytes,
  attainable: plan.attainable,
  actions: plan.actions.map((action) => ({
    kind: action.kind,
    resource_id: action.resourceId,
    name: action.name,
    size_bytes: action.sizeBytes,
    agents: action.agents,
    side_chats: action.sideChats,
    description: action.description
  })),
  blockers: plan.blockers,
  created_at: plan.createdAt
})

const internalError = (): HttpApiError.InternalServerError =>
  new HttpApiError.InternalServerError({})

export const StorageHandlers = HttpApiBuilder.group(
  ArdenApi,
  "storage",
  Effect.fn("StorageHandlers")(function* (handlers) {
    const storage = yield* StorageMaintenance
    const policy = yield* StoragePolicyStore
    const backfills = yield* BackfillStore
    return handlers
      .handle("backfills", () =>
        backfills.progress().pipe(
          Effect.map((list) => ({ backfills: list })),
          Effect.mapError(internalError)
        )
      )
      .handle("files", () => storage.files().pipe(Effect.mapError(internalError)))
      .handle("retention", () =>
        policy.retention().pipe(
          Effect.map((value) => ({
            agent_trace_days: value.agentTraceDays,
            wiki_history_days: value.wikiHistoryDays
          })),
          Effect.mapError(internalError)
        )
      )
      .handle("updateRetention", ({ payload }) =>
        policy
          .updateRetention({
            agentTraceDays: payload.agent_trace_days,
            wikiHistoryDays: payload.wiki_history_days
          })
          .pipe(
            Effect.map((value) => ({
              agent_trace_days: value.agentTraceDays,
              wiki_history_days: value.wikiHistoryDays
            })),
            Effect.mapError(internalError)
          )
      )
      .handle("overview", () =>
        storage.overview().pipe(Effect.map(overviewResponse), Effect.mapError(internalError))
      )
      .handle("tidy", () =>
        storage.tidy().pipe(Effect.map(overviewResponse), Effect.mapError(internalError))
      )
      .handle("updateSettings", ({ payload }) =>
        storage
          .updateSettings({
            maxSpaceGiB: payload.max_space_gib,
            allowArchivedSessionDeletion: payload.allow_archived_session_deletion,
            allowInactiveSessionDeletion: payload.allow_inactive_session_deletion,
            inactiveSessionDays: payload.inactive_session_days,
            minimumCurrentSessions: payload.minimum_current_sessions
          })
          .pipe(Effect.map(overviewResponse), Effect.catch(failStore))
      )
      .handle("previewCleanup", ({ payload }) =>
        storage
          .preview({
            currentSessionId: payload.current_session_id,
            pinnedSessionIds: payload.pinned_session_ids
          })
          .pipe(
            Effect.map(({ id, plan }) => cleanupPlanResponse(id, plan)),
            Effect.mapError(internalError)
          )
      )
      .handle("executeCleanup", ({ payload }) =>
        storage
          .execute(payload.plan_id, {
            currentSessionId: payload.current_session_id,
            pinnedSessionIds: payload.pinned_session_ids
          })
          .pipe(
            Effect.map((receipt) => ({
              plan_id: receipt.planId,
              reclaimed_bytes: receipt.reclaimedBytes,
              actions_completed: receipt.actionsCompleted,
              overview: overviewResponse(receipt.overview)
            })),
            Effect.catch(failStore)
          )
      )
  })
)
