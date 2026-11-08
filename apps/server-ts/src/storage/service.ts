import { countOf, groupedCount } from "@arden-hq/std/count"
import type {
  StorageFiles,
  StorageCategory,
  StorageCleanupAction,
  StorageCleanupContext,
  StorageCleanupPlan,
  StorageCleanupRun,
  StorageOverview,
  StorageSettings
} from "@arden-hq/protocol/storage"
import { Context, Effect, Layer, Semaphore } from "effect"

import { StoragePolicyStore } from "../persistence/storage/store.js"
import {
  StorageSessionStore,
  type StorageSessionCandidate,
  type StorageSessionProtection
} from "../persistence/storage/session-store.js"
import { StorageError, storageError, type StorageOperation } from "./errors.js"
import {
  addSafe,
  filesystem,
  scanInventoryUnsafe,
  type CategoryTally,
  type RootBucket
} from "./inventory.js"
import { makeStorageFiles } from "./files.js"
import { SessionFileCleanup } from "./session-file-cleanup.js"
import { currentIso, currentMillis } from "../runtime/clock.js"
import { sha256Hex } from "@arden-hq/std/hash"

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000
const GIB_BYTES = 1_024 ** 3
const CLEANUP_TARGET_SHARE = 0.85

const categoryDetails = [
  { id: "chats", label: "Chats", description: "Your conversations, including archived ones." },
  {
    id: "channels",
    label: "Automation chats",
    description: "The chats your automations keep for themselves."
  },
  { id: "agents", label: "Agent work", description: "Records of what agents did for you." },
  { id: "knowledge", label: "Knowledge", description: "Wiki pages and their history." },
  { id: "skills", label: "Skills", description: "Installed skills." },
  {
    id: "housekeeping",
    label: "Housekeeping",
    description: "Arden's own bookkeeping: search index, event history, free space."
  },
  {
    id: "other",
    label: "Other files",
    description: "Files in Arden's folder that it does not manage."
  }
] as const satisfies ReadonlyArray<Pick<StorageCategory, "id" | "label" | "description">>

type CategoryId = StorageCategory["id"]

interface CleanupCandidate {
  readonly session: StorageSessionCandidate
  readonly action: StorageCleanupAction
}

interface InternalCleanupPlan {
  readonly id: string
  readonly plan: StorageCleanupPlan
  readonly candidates: ReadonlyArray<CleanupCandidate>
}

export interface StorageCleanupReceipt extends StorageCleanupRun {
  readonly planId: string
}

export interface StorageMaintenanceOptions {
  readonly root: string
  readonly databaseName: string | null
}

const planId = (
  settings: StorageSettings,
  context: StorageCleanupContext,
  plan: StorageCleanupPlan,
  candidates: ReadonlyArray<CleanupCandidate>
): string =>
  sha256Hex(
    JSON.stringify({
      settings,
      context: {
        currentSessionId: context.currentSessionId,
        pinnedSessionIds: [...context.pinnedSessionIds].sort()
      },
      plan: {
        budgetBytes: plan.budgetBytes,
        targetBytes: plan.targetBytes,
        actions: plan.actions
      },
      candidates: candidates.map((candidate) => candidate.session)
    })
  )

const maxBytes = (settings: StorageSettings): number | null =>
  settings.maxSpaceGiB === null ? null : Math.floor(settings.maxSpaceGiB * GIB_BYTES)

const cleanupTargetBytes = (settings: StorageSettings): number | null => {
  const budgetBytes = maxBytes(settings)
  return budgetBytes === null ? null : Math.floor(budgetBytes * CLEANUP_TARGET_SHARE)
}

const inventoryTotal = (tallies: Record<RootBucket, CategoryTally>): number =>
  Object.values(tallies).reduce((total, tally) => addSafe(total, tally.totalBytes), 0)

type PlanProtection =
  | StorageSessionProtection
  | "current_session"
  | "invalid_activity"
  | "minimum_current_sessions"
  | "pinned_session"
  | "recent_activity"

const protectionLabel: Record<PlanProtection, string> = {
  active_work: "active work",
  automation_or_task: "Automation or Task ownership",
  current_session: "currently open",
  space_owned: "Space ownership",
  invalid_activity: "invalid activity metadata",
  linked_session: "linked chats that stay",
  minimum_current_sessions: "minimum current Chats",
  pinned_session: "pinned",
  recent_activity: "recent activity",
  unfinished_todo: "unfinished todo"
}

const make = Effect.fn("StorageMaintenance.make")(function* (options: StorageMaintenanceOptions) {
  const policy = yield* StoragePolicyStore
  const sessionStore = yield* StorageSessionStore
  const fileCleanup = yield* SessionFileCleanup
  const semaphore = yield* Semaphore.make(1)
  const files = makeStorageFiles(options)

  const scanInventory = (operation: StorageOperation) =>
    filesystem(operation, "Could not inspect Arden storage", () =>
      scanInventoryUnsafe(options.root, options.databaseName)
    )

  const readPolicy = (operation: StorageOperation) =>
    policy
      .settings()
      .pipe(Effect.mapError((cause) => storageError(operation, cause.reason, cause.message, cause)))

  const measureDatabase = (operation: StorageOperation) =>
    sessionStore
      .breakdown()
      .pipe(Effect.mapError((cause) => storageError(operation, cause.reason, cause.message, cause)))

  const buildOverview = Effect.fn("StorageMaintenance.buildOverview")(function* (
    operation: StorageOperation
  ) {
    const checkedAt = currentIso()
    const [settings, tallies, database] = yield* Effect.all(
      [readPolicy(operation), scanInventory(operation), measureDatabase(operation)],
      { concurrency: 3 }
    )
    const budgetBytes = maxBytes(settings)
    const databaseExtra = Math.max(0, tallies.database.totalBytes - database.fileBytes)
    const bucketBytes: Record<CategoryId, number> = {
      chats: addSafe(tallies.chats.totalBytes, database.chatsBytes),
      channels: database.channelsBytes,
      agents: addSafe(tallies.agents.totalBytes, database.agentsBytes),
      knowledge: addSafe(tallies.knowledge.totalBytes, database.knowledgeBytes),
      skills: tallies.skills.totalBytes,
      housekeeping: addSafe(
        addSafe(tallies.housekeeping.totalBytes, database.housekeepingBytes),
        databaseExtra
      ),
      other: tallies.other.totalBytes
    }
    const bucketFiles: Record<CategoryId, number> = {
      chats: tallies.chats.itemCount,
      channels: 0,
      agents: tallies.agents.itemCount,
      knowledge: tallies.knowledge.itemCount,
      skills: tallies.skills.itemCount,
      housekeeping: addSafe(tallies.housekeeping.itemCount, tallies.database.itemCount),
      other: tallies.other.itemCount
    }
    const bucketDetail: Record<CategoryId, string> = {
      chats: `${groupedCount(database.currentChats)} current, ${groupedCount(database.archivedChats)} archived`,
      channels: countOf(database.channels, "chat"),
      agents: countOf(database.agentRuns, "run"),
      knowledge: countOf(tallies.knowledge.itemCount, "file"),
      skills: countOf(tallies.skills.itemCount, "file"),
      housekeeping: "search index, event history, free space",
      other: countOf(tallies.other.itemCount, "file")
    }
    const categories: ReadonlyArray<StorageCategory> = categoryDetails.map((details) => ({
      ...details,
      totalBytes: bucketBytes[details.id],
      itemCount: bucketFiles[details.id],
      detail: bucketDetail[details.id]
    }))
    const totalBytes = categories.reduce(
      (total, category) => addSafe(total, category.totalBytes),
      0
    )
    return {
      status: {
        totalBytes,
        maxBytes: budgetBytes,
        overBudgetBytes: budgetBytes === null ? 0 : Math.max(0, totalBytes - budgetBytes),
        checkedAt,
        categories
      },
      settings
    } satisfies StorageOverview
  })

  const buildPlan = Effect.fn("StorageMaintenance.buildPlan")(function* (
    operation: StorageOperation,
    context: StorageCleanupContext
  ) {
    const [settings, tallies, sessionSnapshot] = yield* Effect.all(
      [
        readPolicy(operation),
        scanInventory(operation),
        sessionStore
          .candidates()
          .pipe(
            Effect.mapError((cause) => storageError(operation, cause.reason, cause.message, cause))
          )
      ],
      { concurrency: 3 }
    )
    const sessions = sessionSnapshot.candidates
    const createdAt = currentIso()
    const beforeBytes = inventoryTotal(tallies)
    const budgetBytes = maxBytes(settings)
    const targetBytes = cleanupTargetBytes(settings)
    const databaseBytes = tallies.database.totalBytes
    const sessionPhysicalScale =
      sessionSnapshot.totalLogicalBytes === 0
        ? 0
        : Math.min(1, databaseBytes / sessionSnapshot.totalLogicalBytes)
    const current = sessions
      .filter((session) => !session.archived)
      .sort(
        (left, right) =>
          right.lastActivity.localeCompare(left.lastActivity) ||
          right.sessionId.localeCompare(left.sessionId)
      )
    const minimumCurrent = new Set(
      current.slice(0, settings.minimumCurrentSessions).map((session) => session.sessionId)
    )
    const pinned = new Set(context.pinnedSessionIds)
    const inactiveBefore = currentMillis() - settings.inactiveSessionDays * DAY_MILLISECONDS
    const protectionsFor = (session: StorageSessionCandidate): ReadonlyArray<PlanProtection> => {
      const protections: Array<PlanProtection> = [...session.protections]
      const tree = [session.sessionId, ...session.deletesWith.sessionIds]
      if (context.currentSessionId !== null && tree.includes(context.currentSessionId))
        protections.push("current_session")
      if (tree.some((sessionId) => pinned.has(sessionId))) protections.push("pinned_session")
      if (!session.archived && minimumCurrent.has(session.sessionId)) {
        protections.push("minimum_current_sessions")
      }
      const lastActivity = Date.parse(session.lastActivity)
      if (!Number.isFinite(lastActivity)) protections.push("invalid_activity")
      else if (!session.archived && lastActivity > inactiveBefore) {
        protections.push("recent_activity")
      }
      return [...new Set(protections)]
    }
    const sessionProtections = new Map(
      sessions.map((session) => [session.sessionId, protectionsFor(session)])
    )
    const selected: Array<CleanupCandidate> = []
    let selectedBytes = 0
    const addSessions = (
      candidates: ReadonlyArray<StorageSessionCandidate>,
      kind: "delete_archived_session" | "delete_inactive_session"
    ): void => {
      for (const session of candidates) {
        if (targetBytes === null || Math.max(0, beforeBytes - selectedBytes) <= targetBytes) return
        if ((sessionProtections.get(session.sessionId) ?? []).length > 0) continue
        const estimatedPhysicalBytes = Math.floor(session.sizeBytes * sessionPhysicalScale)
        if (estimatedPhysicalBytes <= 0) continue
        selected.push({
          session,
          action: {
            kind,
            resourceId: session.sessionId,
            name: session.name,
            sizeBytes: estimatedPhysicalBytes,
            agents: session.deletesWith.agents,
            sideChats: session.deletesWith.sideChats,
            description:
              kind === "delete_archived_session"
                ? "Permanently delete archived Chat."
                : "Permanently delete inactive current Chat."
          }
        })
        selectedBytes = addSafe(selectedBytes, estimatedPhysicalBytes)
      }
    }
    if (settings.allowArchivedSessionDeletion) {
      addSessions(
        sessions.filter((session) => session.archived),
        "delete_archived_session"
      )
    }
    if (settings.allowInactiveSessionDeletion) {
      addSessions(
        sessions.filter((session) => !session.archived),
        "delete_inactive_session"
      )
    }

    const estimatedAfterBytes = Math.max(0, beforeBytes - selectedBytes)
    const attainable = targetBytes === null || estimatedAfterBytes <= targetBytes
    const blockers: Array<string> = []
    if (
      budgetBytes === null &&
      (settings.allowArchivedSessionDeletion || settings.allowInactiveSessionDeletion)
    ) {
      blockers.push("Set a maximum to include Chats in a cleanup plan.")
    }
    if (budgetBytes !== null && !attainable) {
      const archivedCount = sessions.filter((session) => session.archived).length
      const currentCount = sessions.length - archivedCount
      if (!settings.allowArchivedSessionDeletion && archivedCount > 0) {
        blockers.push("Archived Chat deletion is off.")
      }
      if (!settings.allowInactiveSessionDeletion && currentCount > 0) {
        blockers.push("Inactive current Chat deletion is off.")
      }
      const protectionCounts = new Map<PlanProtection, number>()
      for (const session of sessions) {
        const protections = sessionProtections.get(session.sessionId) ?? []
        for (const protection of protections) {
          protectionCounts.set(protection, (protectionCounts.get(protection) ?? 0) + 1)
        }
      }
      for (const [protection, count] of protectionCounts) {
        blockers.push(
          `${count} Chat${count === 1 ? " is" : "s are"} protected by ${protectionLabel[protection]}.`
        )
      }
      blockers.push("The saved policy cannot reach the storage maximum.")
    }
    const plan: StorageCleanupPlan = {
      beforeBytes,
      budgetBytes,
      targetBytes,
      estimatedAfterBytes,
      estimatedReclaimableBytes: selectedBytes,
      attainable,
      actions: selected.map((candidate) => candidate.action),
      blockers,
      createdAt
    }
    return { id: planId(settings, context, plan, selected), plan, candidates: selected }
  })

  const overview = () => buildOverview("overview")

  const tidy = () =>
    semaphore.withPermit(
      Effect.gen(function* () {
        yield* sessionStore
          .compact()
          .pipe(
            Effect.mapError((cause) => storageError("tidy", cause.reason, cause.message, cause))
          )
        return yield* buildOverview("tidy")
      })
    )
  const preview = (context: StorageCleanupContext) => buildPlan("preview", context)

  const updateSettings = (settings: StorageSettings) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        yield* policy
          .updateSettings(settings)
          .pipe(
            Effect.mapError((cause) =>
              storageError("update_settings", cause.reason, cause.message, cause)
            )
          )
        return yield* buildOverview("update_settings")
      })
    )

  const execute = (requestedPlanId: string, context: StorageCleanupContext) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const current = yield* buildPlan("execute", context)
        if (current.id !== requestedPlanId) {
          return yield* storageError(
            "execute",
            "conflict",
            "Storage changed; preview cleanup again"
          )
        }
        const deleted = yield* Effect.forEach(current.candidates, (candidate) =>
          sessionStore
            .deleteCandidate(candidate.session)
            .pipe(
              Effect.mapError((cause) =>
                storageError("execute", cause.reason, cause.message, cause)
              )
            )
        ).pipe(Effect.exit)
        if (current.candidates.length > 0) yield* fileCleanup.drainAfterDelete()
        yield* deleted

        if (current.candidates.length > 0) {
          yield* sessionStore
            .compact()
            .pipe(
              Effect.mapError((cause) =>
                storageError("execute", cause.reason, cause.message, cause)
              )
            )
        }

        const nextOverview = yield* buildOverview("execute")

        return {
          planId: current.id,
          reclaimedBytes: Math.max(0, current.plan.beforeBytes - nextOverview.status.totalBytes),
          actionsCompleted: current.candidates.length,
          overview: nextOverview
        } satisfies StorageCleanupReceipt
      })
    )

  return StorageMaintenance.of({
    overview,
    preview,
    execute,
    updateSettings,
    tidy,
    files: files.list
  })
})

export class StorageMaintenance extends Context.Service<
  StorageMaintenance,
  {
    readonly files: () => Effect.Effect<StorageFiles, StorageError>
    readonly overview: () => Effect.Effect<StorageOverview, StorageError>
    readonly preview: (
      context: StorageCleanupContext
    ) => Effect.Effect<InternalCleanupPlan, StorageError>
    readonly execute: (
      planId: string,
      context: StorageCleanupContext
    ) => Effect.Effect<StorageCleanupReceipt, StorageError>
    readonly updateSettings: (
      settings: StorageSettings
    ) => Effect.Effect<StorageOverview, StorageError>
    readonly tidy: () => Effect.Effect<StorageOverview, StorageError>
  }
>()("@arden-hq/server/storage/StorageMaintenance") {}

export const storageMaintenanceLayer = (
  options: StorageMaintenanceOptions
): Layer.Layer<
  StorageMaintenance,
  never,
  StoragePolicyStore | StorageSessionStore | SessionFileCleanup
> => Layer.effect(StorageMaintenance, make(options))
