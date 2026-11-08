import { ProtocolError } from "../common/errors.js"
import { decodeStorageBackfills } from "./backfills.js"
import { decodeStorageFiles } from "./files.js"
import { decodeStorageRetention, encodeStorageRetention } from "./retention.js"
import { makeEncoder, projectedDecoderFor, runBoundary } from "../common/boundary.js"
import type {
  PreparedStorageCleanupPreview,
  PreparedStorageCleanupRequest,
  StorageCleanupContext,
  StorageCleanupPlan,
  StorageSettingsPatch
} from "./contracts.js"
import {
  decodeStorageCleanupPlanEffect,
  decodeStorageCleanupRunForPlanEffect,
  StorageOverviewResponseSchema,
  mapOverview,
  encodeStorageCleanupContextEffect,
  encodeStorageCleanupRequestEffect,
  encodeStorageSettingsPatchEffect,
  getStoragePlanId
} from "./schema.js"

export * from "./contracts.js"

export const storageDecoders = {
  backfills: decodeStorageBackfills,
  files: decodeStorageFiles,
  retention: decodeStorageRetention,
  overview: projectedDecoderFor(
    StorageOverviewResponseSchema,
    mapOverview,
    "Invalid Storage overview"
  )
} as const

export const storageRequests = {
  updateRetention: encodeStorageRetention,
  preview: (context: StorageCleanupContext): PreparedStorageCleanupPreview => ({
    body: runBoundary(
      encodeStorageCleanupContextEffect(context),
      "Invalid Storage cleanup context",
      "encode"
    ),
    decode: (value: unknown): StorageCleanupPlan =>
      runBoundary(
        decodeStorageCleanupPlanEffect(value),
        "Invalid Storage cleanup preview",
        "decode"
      )
  }),
  execute: (
    plan: StorageCleanupPlan,
    context: StorageCleanupContext
  ): PreparedStorageCleanupRequest => {
    const planId = getStoragePlanId(plan)
    if (planId === undefined) {
      throw new ProtocolError(
        "Storage cleanup plans must come from storageRequests.preview().decode",
        { kind: "encode" }
      )
    }
    return {
      body: runBoundary(
        encodeStorageCleanupRequestEffect(planId, context),
        "Invalid Storage cleanup request",
        "encode"
      ),
      decode: (value: unknown) =>
        runBoundary(
          decodeStorageCleanupRunForPlanEffect(value, planId, plan.actions.length),
          "Invalid Storage cleanup result",
          "decode"
        )
    }
  },
  updateSettings: makeEncoder<StorageSettingsPatch>(
    encodeStorageSettingsPatchEffect,
    "Invalid Storage settings patch"
  )
} as const

export const storageRoutes = {
  backfills: "/storage/backfills",
  files: "/storage/files",
  retention: "/storage/retention",
  overview: "/storage",
  settings: "/storage/settings",
  cleanupPreview: "/storage/cleanup/preview",
  cleanup: "/storage/cleanup",
  tidy: "/storage/tidy"
} as const

export { DEFAULT_STORAGE_RETENTION, type StorageRetention } from "./retention.js"

export type { StorageFile, StorageFiles } from "./files.js"
export type { StorageBackfill, StorageBackfills } from "./backfills.js"
