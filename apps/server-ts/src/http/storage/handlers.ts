import {
  STORAGE_LIMIT,
  type StorageCleanupPlan,
  type StorageOverview,
  type StorageSettings
} from "@arden-hq/protocol/storage"
import { currentSessionFromWire } from "@arden-hq/protocol/effect/storage"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { StoragePolicyStore } from "../../persistence/storage/store.js"
import { StorageMaintenance } from "../../storage/service.js"
import { BackfillStore } from "../../persistence/backfills/store.js"
import { ArdenApi } from "../api.js"
import { failInternal, failStore } from "../errors.js"

const settingsResponse = (settings: StorageSettings) => ({
  max_space: settings.maxSpace,
  allow_archived_session_deletion: settings.allowArchivedSessionDeletion,
  allow_inactive_session_deletion: settings.allowInactiveSessionDeletion,
  inactive_session_days: settings.inactiveSessionDays,
  minimum_current_sessions: settings.minimumCurrentSessions
})

const overviewResponse = (overview: StorageOverview) => ({
  status: {
    total_bytes: overview.status.totalBytes,
    budget:
      overview.status.budget.kind === STORAGE_LIMIT.limited
        ? {
            kind: overview.status.budget.kind,
            max_bytes: overview.status.budget.maxBytes,
            over_budget_bytes: overview.status.budget.overBudgetBytes
          }
        : overview.status.budget,
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
  settings: settingsResponse(overview.settings)
})

const cleanupPlanResponse = (id: string, plan: StorageCleanupPlan) => ({
  plan_id: id,
  before_bytes: plan.beforeBytes,
  target:
    plan.target.kind === STORAGE_LIMIT.limited
      ? {
          kind: plan.target.kind,
          budget_bytes: plan.target.budgetBytes,
          target_bytes: plan.target.targetBytes
        }
      : plan.target,
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
          Effect.catch(failInternal("Storage"))
        )
      )
      .handle("files", () => storage.files().pipe(Effect.catch(failInternal("Storage"))))
      .handle("retention", () =>
        policy.retention().pipe(
          Effect.map((value) => ({
            agent_trace: value.agentTrace,
            wiki_history: value.wikiHistory
          })),
          Effect.catch(failInternal("Storage"))
        )
      )
      .handle("updateRetention", ({ payload }) =>
        policy
          .updateRetention({
            agentTrace: payload.agent_trace,
            wikiHistory: payload.wiki_history
          })
          .pipe(
            Effect.map((value) => ({
              agent_trace: value.agentTrace,
              wiki_history: value.wikiHistory
            })),
            Effect.catch(failInternal("Storage"))
          )
      )
      .handle("overview", () =>
        storage.overview().pipe(Effect.map(overviewResponse), Effect.catch(failInternal("Storage")))
      )
      .handle("settings", () =>
        policy.settings().pipe(Effect.map(settingsResponse), Effect.catch(failStore))
      )
      .handle("tidy", () =>
        storage.tidy().pipe(Effect.map(overviewResponse), Effect.catch(failInternal("Storage")))
      )
      .handle("updateSettings", ({ payload }) =>
        storage
          .updateSettings({
            maxSpace: payload.max_space,
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
            currentSession: currentSessionFromWire(payload.current_session),
            pinnedSessionIds: payload.pinned_session_ids
          })
          .pipe(
            Effect.map(({ id, plan }) => cleanupPlanResponse(id, plan)),
            Effect.catch(failInternal("Storage"))
          )
      )
      .handle("executeCleanup", ({ payload }) =>
        storage
          .execute(payload.plan_id, {
            currentSession: currentSessionFromWire(payload.current_session),
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
